/**
 * The learning-path eval (build plan 8.7, test plan §6.3): for each topic in
 * `dataset/paths.json`, builds learning paths through the real job steps (no Inngest), then
 * measures
 * - **coverage**: the topic's core sections covered by the path's included concepts (judge), and
 * - **consistency**: overlap of included concepts across `pathRuns` builds of the same topic and
 *   level (Jaccard, by exact name and by meaning).
 *
 *   pnpm eval:paths                       # every topic: beginner + intermediate × 3, advanced × 1
 *   pnpm eval:paths -- --topics=python    # these topics only
 *   pnpm eval:paths -- --runs=1           # one build per level (no consistency number)
 *   pnpm eval:paths -- --reuse            # keep each topic's resources from the last run
 *
 * Resources are gathered and read once per topic (real Tavily / Firecrawl / Supadata calls, real
 * embeddings), then every build reuses them, so consistency measures the outline steps (map →
 * merge → order → cut), the part that is ours. `--reuse` skips the gathering entirely.
 *
 * Runs against the Neon `dev` branch (`DATABASE_URL`) and refuses production and test. Calls
 * OpenAI (Luna for the path steps and the judge, embeddings), Tavily and Firecrawl; the run
 * prints and records what it cost.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { and, eq, like } from 'drizzle-orm';
import {
  chunking,
  embeddingRequests,
  embeddings as embeddingModel,
  extraction,
  ingestion,
  learningPaths as learningPathsConfig,
  llmModels,
  llmRequests,
  llmTasks,
  webSearch,
} from '../../apps/server/src/config/index.js';
import { createDb } from '../../apps/server/src/db/client.js';
import { learningPaths, notebooks, users } from '../../apps/server/src/db/schema/index.js';
import { createOpenAiEmbeddings } from '../../apps/server/src/lib/embeddings/index.js';
import {
  createOpenAiLlm,
  type LlmProvider,
  type LlmUsage,
} from '../../apps/server/src/lib/llm/index.js';
import { createUnpdfParser } from '../../apps/server/src/lib/pdf/index.js';
import { createFirecrawlScraper } from '../../apps/server/src/lib/scraper/index.js';
import {
  createFirecrawlSearch,
  createTavilySearch,
  withSearchFallback,
  type SearchProvider,
} from '../../apps/server/src/lib/search/index.js';
import type { Tracer } from '../../apps/server/src/lib/tracing/index.js';
import { createSupadataTranscriptProvider } from '../../apps/server/src/lib/transcript/index.js';
import { createLogger } from '../../apps/server/src/logger.js';
import { countTokens } from '../../apps/server/src/pipelines/ingestion/tokens.js';
import { createIngestionRepository } from '../../apps/server/src/repositories/ingestion.repository.js';
import {
  createLearningPathsRepository,
  type PathRef,
} from '../../apps/server/src/repositories/learning-paths.repository.js';
import {
  createIngestionService,
  type StepAttempt,
} from '../../apps/server/src/services/ingestion.service.js';
import { createLearningPathGenerationService } from '../../apps/server/src/services/learning-path-generation.service.js';
import { createLearningPathOutlineService } from '../../apps/server/src/services/learning-path-outline.service.js';
import { usageCost } from '../src/answers.js';
import { evalConfig } from '../src/config.js';
import {
  coverage,
  coverageVerdictSchema,
  exactJaccard,
  pairwiseMean,
  readPathTopics,
  semanticJaccard,
  type PathTopic,
} from '../src/paths.js';

type Level = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
const judgesDir = fileURLToPath(new URL('../judges/', import.meta.url));

function parseArgs(argv: string[]) {
  const value = (name: string) =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const runs = Number(value('runs') ?? evalConfig.pathRuns);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  return {
    runs,
    reuse: argv.includes('--reuse'),
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

/** Same guard as the RAG eval: dev only. */
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

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** Records every LLM call's tokens by model, for the cost line. */
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
    stream: (request) => llm.stream(request),
  };
}

/** Counts calls, for the cost line (Tavily: 1 credit per basic search). */
function countSearches(search: SearchProvider, counter: { calls: number }): SearchProvider {
  return {
    search(request) {
      counter.calls += 1;
      return search.search(request);
    },
  };
}

/** No tracing in the eval: the run's own results file is the record. */
const noTracer: Tracer = {
  trace: (_options, fn) => fn({ traceId: 'eval', setOutput: () => undefined }),
  span: (_name, _input, fn) => fn(),
  score: () => Promise.resolve(),
  deleteScore: () => Promise.resolve(),
  flush: () => Promise.resolve(),
};

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const allTopics = await readPathTopics();
  const topics = args.topics ? allTopics.filter((t) => args.topics?.includes(t.id)) : allTopics;
  if (topics.length === 0) throw new Error('--topics matched no topic');
  const coveragePrompt = (await readFile(`${judgesDir}path-coverage.md`, 'utf8')).trim();

  const { db, pool } = createDb(evalDatabaseUrl());
  const logger = createLogger({ level: 'warn', pretty: false });
  const usage = new Map<string, LlmUsage & { calls: number }>();
  const addUsage = (model: string, u: LlmUsage) => {
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
  };
  const llm = trackUsage(
    createOpenAiLlm({
      apiKey: requireEnv('OPENAI_API_KEY'),
      models: llmModels,
      tasks: llmTasks,
      timeoutMs: llmRequests.timeoutMs,
      maxRetries: llmRequests.maxRetries,
    }),
    addUsage,
  );
  const embeddings = createOpenAiEmbeddings({
    apiKey: requireEnv('OPENAI_API_KEY'),
    model: embeddingModel.model,
    dimensions: embeddingModel.dimensions,
    batchSize: embeddingRequests.batchSize,
    timeoutMs: embeddingRequests.timeoutMs,
  });
  const searches = { calls: 0 };
  const search = countSearches(
    withSearchFallback(
      createTavilySearch({
        apiKey: requireEnv('TAVILY_API_KEY'),
        depth: webSearch.depth,
        timeoutMs: webSearch.timeoutMs,
      }),
      createFirecrawlSearch({
        apiKey: requireEnv('FIRECRAWL_API_KEY'),
        timeoutMs: webSearch.timeoutMs,
      }),
      logger,
    ),
    searches,
  );
  const repository = createLearningPathsRepository(db);
  const deps = { repository, llm, tracer: noTracer, logger, limits: learningPathsConfig };
  const generation = createLearningPathGenerationService({ ...deps, search });
  const outline = createLearningPathOutlineService(deps);
  const scrapes = { calls: 0 };
  const firecrawl = createFirecrawlScraper({
    apiKey: requireEnv('FIRECRAWL_API_KEY'),
    timeoutMs: extraction.scrapeTimeoutMs,
  });
  const ingestionService = createIngestionService({
    repository: createIngestionRepository(db, ingestion.chunkInsertBatchSize),
    storage: {
      createUploadUrl: () => Promise.reject(new Error('no uploads in the path eval')),
      createDownloadUrl: () => Promise.reject(new Error('no uploads in the path eval')),
      head: () => Promise.reject(new Error('no uploads in the path eval')),
      download: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
    },
    pdf: createUnpdfParser(),
    scraper: {
      scrape(url) {
        scrapes.calls += 1;
        return firecrawl.scrape(url);
      },
    },
    transcript: createSupadataTranscriptProvider({
      apiKey: requireEnv('TRANSCRIPT_API_KEY'),
      timeoutMs: extraction.transcriptTimeoutMs,
      jobPollAttempts: extraction.transcriptJobPollAttempts,
      jobPollIntervalMs: extraction.transcriptJobPollIntervalMs,
      language: extraction.transcriptLanguage,
    }),
    embeddings,
    jobs: { send: () => Promise.resolve() },
    logger,
    chunking: { ...chunking, countTokens },
    sweep: {
      processingTimeoutMinutes: ingestion.processingTimeoutMinutes,
      pendingResendMinutes: ingestion.pendingResendMinutes,
      batchSize: ingestion.sweepBatchSize,
    },
  });

  /** A step with the job's retries: a throw is retried, the last attempt gets `isLastAttempt`. */
  async function withRetries<T>(label: string, run: (attempt: StepAttempt) => Promise<T>) {
    const attempts = learningPathsConfig.jobRetries + 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run({ isLastAttempt: attempt === attempts });
      } catch (error) {
        if (attempt === attempts) throw error;
        console.warn(`\n${label}: attempt ${String(attempt)} failed (${String(error)}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
    }
  }

  const stopped = (label: string, result: { status: string }) =>
    new Error(`${label} stopped: ${JSON.stringify(result)}`);

  try {
    await db
      .insert(users)
      .values({ clerkUserId: evalConfig.pathEvalUserClerkId })
      .onConflictDoNothing();
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkUserId, evalConfig.pathEvalUserClerkId));
    if (!user) throw new Error('path eval user missing');
    const userId = user.id;

    /** The topic's path, gathered and read; with `--reuse`, the one from the last run. */
    async function preparePath(topic: PathTopic): Promise<PathRef> {
      const title = `Eval path: ${topic.id}`;
      if (args.reuse) {
        const [existing] = await db
          .select({ pathId: learningPaths.id })
          .from(learningPaths)
          .innerJoin(notebooks, eq(notebooks.id, learningPaths.notebookId))
          .where(and(eq(notebooks.userId, userId), like(notebooks.title, title)));
        if (existing) {
          console.log(`${topic.id}: reusing the resources of the last run`);
          return { pathId: existing.pathId, userId: userId };
        }
      }
      await db
        .delete(notebooks)
        .where(and(eq(notebooks.userId, userId), eq(notebooks.title, title)));
      const [notebook] = await db
        .insert(notebooks)
        .values({ userId: userId, title, kind: 'LEARNING' })
        .returning({ id: notebooks.id });
      if (!notebook) throw new Error('eval notebook not created');
      const [path] = await db
        .insert(learningPaths)
        .values({
          notebookId: notebook.id,
          userId: userId,
          topic: topic.topic,
          level: 'BEGINNER',
          goal: topic.goal,
        })
        .returning({ id: learningPaths.id });
      if (!path) throw new Error('eval path not created');
      const ref = { pathId: path.id, userId: userId };

      process.stdout.write(`${topic.id}: searching … `);
      const claimed = await generation.claim(ref);
      if (claimed.status !== 'claimed') throw stopped('claim', claimed);
      const found = await withRetries('search', (a) => generation.search(ref, a));
      if (found.status !== 'searched') throw stopped('search', found);
      const picked = await withRetries('select', (a) =>
        generation.select(ref, found.candidates, a),
      );
      if (picked.status !== 'selected') throw stopped('select', picked);
      const saved = await generation.save(ref, picked.resources);
      if (saved.status !== 'saved') throw stopped('save', saved);
      console.log(`${String(picked.resources.length)} resources; reading …`);

      for (const sourceId of saved.ingest) {
        const run = { userId: userId, sourceId, runId: `eval-${randomUUID()}` };
        for (const [step, fn] of [
          ['start', () => ingestionService.start(run)],
          ['extract', (a: StepAttempt) => ingestionService.extract(run, a)],
          ['chunk', (a: StepAttempt) => ingestionService.chunk(run, a)],
          ['embed-and-commit', (a: StepAttempt) => ingestionService.embedAndCommit(run, a)],
        ] as const) {
          const result = await withRetries(`${sourceId} ${step}`, fn);
          if (result.status !== 'ok') {
            console.warn(`  a resource was not read (${step}: ${JSON.stringify(result)})`);
            break;
          }
        }
      }
      const read = await generation.finishReading(ref, { lastCheck: true });
      if (read.status !== 'read') throw stopped('reading', read);
      console.log(`  ${String(read.ready)} of ${String(read.total)} resources read`);
      return ref;
    }

    /** One build of the outline at `level` on the path's read resources. */
    async function build(ref: PathRef, level: Level) {
      await db
        .update(learningPaths)
        .set({ level, status: 'MAPPING', selectedBranch: null, branchOptions: null })
        .where(eq(learningPaths.id, ref.pathId));
      const listed = await outline.listRead(ref);
      if (listed.status !== 'listed') throw stopped('list', listed);
      const queue = [...listed.resources];
      const mapped: Awaited<ReturnType<typeof outline.mapResource>>[] = [];
      await Promise.all(
        Array.from({ length: evalConfig.mapConcurrency }, async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            const resource = next;
            mapped.push(await withRetries('map', (a) => outline.mapResource(ref, resource, a)));
          }
        }),
      );
      const resources = mapped.flatMap((m) => (m.status === 'mapped' ? [m.resource] : []));
      const merged = await withRetries('merge', () =>
        outline.merge(ref, resources, listed.resources.length),
      );
      if (merged.status !== 'merged') throw stopped('merge', merged);
      const ordered = await withRetries('order', () =>
        outline.order(ref, merged.concepts, merged.resourceCount),
      );
      if (ordered.status !== 'ordered') throw stopped('order', ordered);

      let branch: string | null = null;
      if (level === 'ADVANCED') {
        const offer = await outline.offerBranches(ref, ordered.outline);
        if (offer.status === 'offered') {
          // The learner's pick: the first branch offered.
          branch = ordered.outline.branches[0]?.name ?? null;
          await db
            .update(learningPaths)
            .set({ selectedBranch: branch })
            .where(eq(learningPaths.id, ref.pathId));
          const chosen = await outline.chosenBranch(ref, ordered.outline);
          if (chosen.status !== 'chosen') throw stopped('branch', chosen);
        }
      }
      const built = await outline.build(ref, ordered.outline, branch, merged.resourceCount);
      if (built.status !== 'built') throw stopped('build', built);
      const hooked = await withRetries('hook', (a) => outline.hook(ref, built.cut, a));
      if (hooked.status !== 'hooked') throw stopped('hook', hooked);
      const saved = await outline.save(ref, ordered.outline, built.cut, hooked.hook);
      if (saved.status !== 'ready') throw stopped('save', saved);

      const byKey = new Map(ordered.outline.concepts.map((c) => [c.key, c]));
      const included = built.cut.modules.flatMap((m) =>
        m.conceptKeys.flatMap((key) => {
          const c = byKey.get(key);
          return c ? [{ name: c.name, description: c.description, score: c.score }] : [];
        }),
      );
      const titleOf = new Map(listed.resources.map((r) => [r.resourceId, r.title]));
      return {
        level,
        mapped: resources.map((r) => ({ title: r.title, concepts: r.concepts.length })),
        unmapped: mapped.flatMap((m) =>
          m.status === 'unmapped' ? [titleOf.get(m.resourceId) ?? m.resourceId] : [],
        ),
        branchOptions: ordered.outline.branches.map((b) => b.name),
        branch,
        modules: built.cut.modules.map((m) => m.title),
        included,
        skipped: built.cut.skipped.length,
        concepts: ordered.outline.concepts.length,
        hook: hooked.hook !== null,
      };
    }

    async function judgeCoverage(
      topic: PathTopic,
      included: { name: string; description: string }[],
    ) {
      const sections = topic.sections
        .map((s, i) => `${String(i + 1)}. ${s.name}: ${s.description}`)
        .join('\n');
      const concepts = included.map((c) => `- ${c.name}: ${c.description}`).join('\n');
      const { object } = await llm.generateObject(
        {
          task: 'evalJudge',
          instructions: coveragePrompt,
          messages: [
            {
              role: 'user',
              content: `Topic: ${topic.topic}\n\nCore sections:\n${sections}\n\nConcepts the path teaches:\n${concepts}`,
            },
          ],
        },
        coverageVerdictSchema,
      );
      const result = coverage(object, topic.sections.length);
      return {
        ...result,
        missed: topic.sections
          .filter((_, i) => !result.coveredIndexes.includes(i + 1))
          .map((s) => s.id),
      };
    }

    const results = [];
    for (const topic of topics) {
      const ref = await preparePath(topic);
      const resources = (await repository.listResources(ref)).map((r) => ({
        role: r.role,
        type: r.resourceType,
        title: r.title,
        url: r.url,
        read: r.sourceStatus === 'READY',
      }));
      const levels = [];
      for (const level of [...evalConfig.pathLevels, 'ADVANCED' as const]) {
        const runCount = level === 'ADVANCED' ? 1 : args.runs;
        const runs = [];
        for (let i = 0; i < runCount; i += 1) {
          process.stdout.write(`${topic.id} ${level.toLowerCase()} build ${String(i + 1)} … `);
          const built = await build(ref, level);
          const judged = level === 'ADVANCED' ? null : await judgeCoverage(topic, built.included);
          console.log(
            `${String(built.mapped.length)}/${String(built.mapped.length + built.unmapped.length)} mapped, ` +
              `${String(built.included.length)} concepts in ${String(built.modules.length)} modules` +
              (judged ? `, coverage ${String(judged.rate)}` : `, branch: ${String(built.branch)}`),
          );
          runs.push({ ...built, coverage: judged });
        }
        const vectors = await Promise.all(
          runs.map((r) =>
            r.included.length === 0
              ? Promise.resolve([] as number[][])
              : embeddings.embed(r.included.map((c) => c.name)),
          ),
        );
        const coverageRates = runs.flatMap((r) => (r.coverage ? [r.coverage.rate] : []));
        levels.push({
          level,
          runs,
          meanCoverage:
            coverageRates.length === 0
              ? null
              : Math.round(
                  (coverageRates.reduce((s, n) => s + n, 0) / coverageRates.length) * 1000,
                ) / 1000,
          consistency: {
            exactJaccard: pairwiseMean(
              runs.map((r) => r.included.map((c) => c.name)),
              exactJaccard,
            ),
            semanticJaccard: pairwiseMean(vectors, (a, b) =>
              semanticJaccard(a, b, evalConfig.conceptMatchThreshold),
            ),
          },
        });
      }
      results.push({
        topic: topic.id,
        officialDocs: topic.officialSource !== null,
        resources,
        levels,
      });
    }

    // ── Results ──
    const llmCost = Object.fromEntries(
      [...usage].map(([model, u]) => {
        const price = evalConfig.llmPrices[model];
        if (!price) throw new Error(`No price for model ${model} in evals/src/config.ts`);
        return [model, { ...u, usd: Math.round(usageCost(u, price) * 1e5) / 1e5 }];
      }),
    );
    const summary = results.map((t) => ({
      topic: t.topic,
      ...Object.fromEntries(
        t.levels.map((l) => [
          l.level.toLowerCase(),
          {
            coverage: l.meanCoverage,
            consistencyExact: l.consistency.exactJaccard,
            consistencySemantic: l.consistency.semanticJaccard,
          },
        ]),
      ),
    }));
    const output = {
      kind: 'learning-paths',
      date: new Date().toISOString(),
      commit: git('rev-parse', '--short', 'HEAD'),
      dirty: git('status', '--porcelain') !== '',
      config: {
        runs: args.runs,
        reuse: args.reuse,
        levels: [...evalConfig.pathLevels, 'ADVANCED'],
        conceptMatchThreshold: evalConfig.conceptMatchThreshold,
        consensus: learningPathsConfig.consensus,
        cut: learningPathsConfig.cut,
        models: { learningPath: llmModels.luna, judge: llmTasks.evalJudge.tier },
      },
      summary,
      cost: { llm: llmCost, webSearches: searches.calls, scrapes: scrapes.calls },
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      topics: results,
    };
    await mkdir(evalConfig.resultsDir, { recursive: true });
    const file = `${evalConfig.resultsDir}${output.date.slice(0, 10)}-paths.json`;
    await writeFile(file, `${JSON.stringify(output, null, 2)}\n`);
    console.table(
      summary.flatMap((s) =>
        ['beginner', 'intermediate'].map((level) => {
          const l = (s as Record<string, unknown>)[level] as
            | {
                coverage: number | null;
                consistencyExact: number | null;
                consistencySemantic: number | null;
              }
            | undefined;
          return { topic: s.topic, level, ...l };
        }),
      ),
    );
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
