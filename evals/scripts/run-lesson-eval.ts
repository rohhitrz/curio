/**
 * The lesson eval (build plan 9.7, test plan §6.3): writes lessons with the real pipeline
 * (retrieval per concept → teaching prompt → citation check) for the first modules of the paths
 * the path eval built, and judges **lesson faithfulness**: supported factual claims ÷ factual
 * claims, against the passages each lesson cites. Code blocks and general-knowledge sections are
 * removed before judging; the judge skips examples and analogies (decision L-10).
 *
 *   pnpm eval:lessons                      # every topic with a built eval path
 *   pnpm eval:lessons -- --topics=python   # these topics only
 *   pnpm eval:lessons -- --modules=2       # lessons per topic (default 3)
 *
 * Needs the path eval's paths on dev (`pnpm eval:paths` first; the last saved outline is used). Lessons are not saved. Runs
 * against the Neon `dev` branch (`DATABASE_URL`) and refuses production and test. Calls OpenAI
 * (Luna for lessons and the judge, embeddings) and Cohere (rerank, paced for Trial keys); the run
 * prints and records what it cost.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { and, asc, eq, like } from 'drizzle-orm';
import {
  citations as citationLimits,
  embeddingRequests,
  embeddings as embeddingModel,
  lessons as lessonLimits,
  llmModels,
  llmRequests,
  llmTasks,
  rerankModels,
  rerankRequests,
  retrievalFlags,
} from '../../apps/server/src/config/index.js';
import { createDb } from '../../apps/server/src/db/client.js';
import { learningPaths, modules, notebooks, users } from '../../apps/server/src/db/schema/index.js';
import { createOpenAiEmbeddings } from '../../apps/server/src/lib/embeddings/index.js';
import {
  createOpenAiLlm,
  type LlmProvider,
  type LlmUsage,
} from '../../apps/server/src/lib/llm/index.js';
import { createCohereRerank } from '../../apps/server/src/lib/rerank/index.js';
import { countTokens } from '../../apps/server/src/pipelines/ingestion/tokens.js';
import { buildLessonContext } from '../../apps/server/src/pipelines/lessons/context.js';
import { generateLesson } from '../../apps/server/src/pipelines/lessons/generate.js';
import { retrieveForConcepts } from '../../apps/server/src/pipelines/lessons/retrieve.js';
import { rerankChunks } from '../../apps/server/src/pipelines/retrieval/rerank.js';
import { createLessonsRepository } from '../../apps/server/src/repositories/lessons.repository.js';
import { createRetrievalRepository } from '../../apps/server/src/repositories/retrieval.repository.js';
import { faithfulnessVerdictSchema, usageCost } from '../src/answers.js';
import { evalConfig } from '../src/config.js';
import { lessonFaithfulness, lessonForJudging, pooledFaithfulness } from '../src/lessons.js';
import { readPathTopics } from '../src/paths.js';

const judgesDir = fileURLToPath(new URL('../judges/', import.meta.url));

function parseArgs(argv: string[]) {
  const value = (name: string) =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const modulesPerTopic = Number(value('modules') ?? evalConfig.lessonModules);
  if (!Number.isInteger(modulesPerTopic) || modulesPerTopic < 1) {
    throw new Error('--modules must be a positive integer');
  }
  return {
    modulesPerTopic,
    topics: value('topics')
      ?.split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from .env`);
  return value;
}

function databaseIdentity(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/-pooler(?=\.)/, '');
  return `${host}:${parsed.port || '5432'}${parsed.pathname}`;
}

/** Same guard as the other evals: dev only. */
function evalDatabaseUrl(): string {
  const url = requireEnv('DATABASE_URL');
  for (const name of ['PROD_DATABASE_URL', 'TEST_DATABASE_URL']) {
    const other = process.env[name];
    if (other && databaseIdentity(other) === databaseIdentity(url)) {
      throw new Error(`DATABASE_URL points at the same database as ${name}; evals run on dev.`);
    }
  }
  return url;
}

/** Neon `dev` drops a connection now and then; such a lesson is written again. */
const isDroppedConnection = (error: unknown) =>
  error instanceof Error &&
  /Connection terminated|ECONNRESET|socket hang up|terminating connection/i.test(
    `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`,
  );
const LESSON_ATTEMPTS = 3;

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** Records every LLM call's tokens by model, for the cost line (streams included). */
function trackUsage(llm: LlmProvider, add: (model: string, usage: LlmUsage) => void): LlmProvider {
  return {
    async generate(request) {
      const result = await llm.generate(request);
      add(result.model, result.usage);
      return result;
    },
    async generateObject(request, schema) {
      const result = await llm.generateObject(request, schema);
      add(result.model, result.usage);
      return result;
    },
    stream(request) {
      const stream = llm.stream(request);
      void stream.result.then(
        (result) => add(result.model, result.usage),
        () => undefined,
      );
      return stream;
    },
  };
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const allTopics = await readPathTopics();
  const topics = args.topics ? allTopics.filter((t) => args.topics?.includes(t.id)) : allTopics;
  if (topics.length === 0) throw new Error('--topics matched no topic');
  const judgePrompt = (await readFile(`${judgesDir}lesson-faithfulness.md`, 'utf8')).trim();

  // Lessons wait on model calls for a minute or more: close idle connections early (5s), so a
  // connection Neon dropped meanwhile is never reused.
  const { db, pool } = createDb(evalDatabaseUrl(), undefined, 5_000);
  const usage = new Map<string, LlmUsage & { calls: number }>();
  const llm = trackUsage(
    createOpenAiLlm({
      apiKey: requireEnv('OPENAI_API_KEY'),
      models: llmModels,
      tasks: llmTasks,
      timeoutMs: llmRequests.timeoutMs,
      maxRetries: llmRequests.maxRetries,
    }),
    (model, u) => {
      const total = usage.get(model) ?? {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        calls: 0,
      };
      total.inputTokens += u.inputTokens;
      total.cachedInputTokens += u.cachedInputTokens;
      total.outputTokens += u.outputTokens;
      total.calls += 1;
      usage.set(model, total);
    },
  );
  const embeddings = createOpenAiEmbeddings({
    apiKey: requireEnv('OPENAI_API_KEY'),
    model: embeddingModel.model,
    dimensions: embeddingModel.dimensions,
    batchSize: embeddingRequests.batchSize,
    timeoutMs: embeddingRequests.timeoutMs,
  });
  const reranker = createCohereRerank({
    apiKey: requireEnv('COHERE_API_KEY'),
    model: rerankModels.default,
    timeoutMs: evalConfig.rerankTimeoutMs,
    maxTokensPerDoc: rerankRequests.maxTokensPerDoc,
  });
  const rerankUsage = { calls: 0, searchUnits: 0 };
  // One rerank per concept: spaced to stay under a Trial key's limit (else the gate is skipped).
  let lastRerankAt = 0;
  const rerankPacer = async () => {
    const gapMs = 60_000 / evalConfig.rerankCallsPerMinute + 100;
    const wait = lastRerankAt + gapMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRerankAt = Date.now();
  };
  const retrievalRepository = createRetrievalRepository(db);
  const lessonsRepository = createLessonsRepository(db);
  const failedSteps: string[] = [];

  try {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkUserId, evalConfig.pathEvalUserClerkId));
    if (!user) throw new Error('No path eval user on dev: run `pnpm eval:paths` first.');

    const results = [];
    for (const topic of topics) {
      const [path] = await db
        .select({ id: learningPaths.id, status: learningPaths.status, level: learningPaths.level })
        .from(learningPaths)
        .innerJoin(notebooks, eq(notebooks.id, learningPaths.notebookId))
        .where(and(eq(notebooks.userId, user.id), like(notebooks.title, `Eval path: ${topic.id}`)));
      if (!path) {
        console.warn(`${topic.id}: no eval path on dev (run pnpm eval:paths); skipped`);
        continue;
      }
      // The last outline the path eval saved (a stopped run leaves its status mid-build; the
      // modules, concepts and read sources are what a lesson needs).
      const chosen = await db
        .select({ id: modules.id })
        .from(modules)
        .where(and(eq(modules.pathId, path.id), eq(modules.isEnabled, true)))
        .orderBy(asc(modules.position))
        .limit(args.modulesPerTopic);
      if (chosen.length === 0) {
        console.warn(
          `${topic.id}: the eval path has no saved outline (run pnpm eval:paths); skipped`,
        );
        continue;
      }

      const lessons = [];
      for (const { id: moduleId } of chosen) {
        for (let attempt = 1; ; attempt += 1) {
          try {
            const written = await writeAndJudge(topic.id, moduleId);
            if (written) lessons.push(written);
            break;
          } catch (error) {
            if (attempt === LESSON_ATTEMPTS || !isDroppedConnection(error)) throw error;
            console.warn(`\nconnection dropped (attempt ${String(attempt)}); writing it again`);
          }
        }
      }
      results.push({ topic: topic.id, level: path.level, pathStatus: path.status, lessons });
    }

    /** One module's lesson, written with the real pipeline and judged; null without concepts. */
    async function writeAndJudge(topicId: string, moduleId: string) {
      const userId = user?.id ?? '';
      {
        const module = await lessonsRepository.forGeneration(userId, moduleId);
        if (!module || module.concepts.length === 0) return null;
        process.stdout.write(
          `${topicId} · ${module.title} (${String(module.concepts.length)} concepts) … `,
        );

        const found = await retrieveForConcepts(
          {
            userId,
            notebookId: module.notebookId,
            concepts: module.concepts,
            chunksPerConcept: lessonLimits.chunksPerConcept,
            // Paced rerank calls: one at a time.
            concurrency: 1,
          },
          {
            flags: retrievalFlags,
            embeddings,
            vectorSearch: (params) => retrievalRepository.vectorSearch(params),
            keywordSearch: (params) => retrievalRepository.keywordSearch(params),
            rerank: async (input) => {
              await rerankPacer();
              rerankUsage.calls += 1;
              return rerankChunks(input, {
                reranker,
                onSearchUnits: (units) => {
                  rerankUsage.searchUnits += units;
                },
              });
            },
            onStepFailed: (step) => failedSteps.push(`${module.title}: ${step}`),
          },
        );
        process.stdout.write('retrieved; writing … ');
        const context = buildLessonContext(found.passages, {
          maxTokens: lessonLimits.contextMaxTokens,
          countTokens,
        });
        const stream = generateLesson(
          {
            topic: module.topic,
            level: module.level,
            goal: module.goal,
            module: { title: module.title, summary: module.summary, why: module.why },
            previous: module.previous,
            profile: null,
            context,
          },
          { llm, snippetMaxChars: citationLimits.snippetMaxChars },
        );
        for await (const _ of stream.textStream) {
          // Read to the end; the result holds the checked text.
        }
        const lesson = await stream.result;

        process.stdout.write('judging … ');
        const judged = lessonForJudging(lesson.text);
        const cited = new Set(lesson.citations.map((c) => c.marker));
        const sources = context.sources
          .filter((s) => cited.has(s.marker))
          .map((s) => `[${String(s.marker)}] ${s.chunk.sourceTitle}\n${s.chunk.content}`)
          .join('\n\n');
        const { object: verdict } = await llm.generateObject(
          {
            task: 'evalLessonJudge',
            instructions: judgePrompt,
            messages: [
              {
                role: 'user',
                content: `Topic: ${module.topic}\nModule: ${module.title}\n\nSources:\n\n${sources || '(The lesson cites no sources.)'}\n\n---\n\nLesson:\n${judged.text}`,
              },
            ],
          },
          faithfulnessVerdictSchema,
        );
        const faithfulness = lessonFaithfulness(verdict.claims);
        console.log(
          `${String(lesson.citations.length)} citations, ${String(verdict.claims.length)} claims, faithfulness ${String(faithfulness)}`,
        );
        return {
          module: module.title,
          concepts: module.concepts.map((c) => c.name),
          generalKnowledge: context.concepts
            .filter((c) => c.markers.length === 0)
            .map((c) => c.concept.name),
          generalKnowledgeSections: judged.generalKnowledgeSections,
          passages: context.sources.length,
          citations: lesson.citations.length,
          removedMarkers: lesson.removedMarkers,
          chars: lesson.text.length,
          faithfulness,
          claims: verdict.claims,
          lesson: lesson.text,
        };
      }
    }

    const all = results.flatMap((t) => t.lessons);
    if (all.length === 0) throw new Error('No lesson was written: nothing to record.');
    const llmCost = Object.fromEntries(
      [...usage].map(([model, u]) => {
        const price = evalConfig.llmPrices[model];
        if (!price) throw new Error(`No price for model ${model} in evals/src/config.ts`);
        return [model, { ...u, usd: Math.round(usageCost(u, price) * 1e5) / 1e5 }];
      }),
    );
    const output = {
      kind: 'lessons',
      date: new Date().toISOString(),
      commit: git('rev-parse', '--short', 'HEAD'),
      dirty: git('status', '--porcelain') !== '',
      config: {
        modulesPerTopic: args.modulesPerTopic,
        flags: retrievalFlags,
        lessons: lessonLimits,
        models: { lesson: llmTasks.lesson, judge: llmTasks.evalLessonJudge },
      },
      summary: {
        lessons: all.length,
        faithfulness: pooledFaithfulness(all),
        claims: all.reduce((n, l) => n + l.claims.length, 0),
        unsupported: all.reduce((n, l) => n + l.claims.filter((c) => !c.supported).length, 0),
        generalKnowledgeConcepts: all.reduce((n, l) => n + l.generalKnowledge.length, 0),
        concepts: all.reduce((n, l) => n + l.concepts.length, 0),
        failedSteps,
      },
      cost: {
        llm: llmCost,
        rerank: {
          ...rerankUsage,
          usd:
            Math.round(
              (rerankUsage.searchUnits / 1000) *
                (evalConfig.rerankPricesPerThousandSearches[rerankModels.default] ?? 0) *
                1e5,
            ) / 1e5,
        },
      },
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      topics: results,
    };
    await mkdir(evalConfig.resultsDir, { recursive: true });
    const file = `${evalConfig.resultsDir}${output.date.slice(0, 10)}-lessons.json`;
    await writeFile(file, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`summary: ${JSON.stringify(output.summary)}`);
    console.log(`cost: ${JSON.stringify(output.cost)}`);
    console.log(`results: ${file}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
