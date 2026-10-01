/**
 * The eval runner (build plans 4.3, 5.6): ingests the golden dataset into an eval notebook through
 * the real ingestion service, asks every question through the real retrieval module, answers it
 * with the real generation step, has the judge model grade the answers, and writes the metrics to
 * `evals/results/<date>-<config>.json` (test plan §6.3–6.6).
 *
 *   pnpm eval                         # retrieval + answer metrics (answers averaged over 2 runs)
 *   pnpm eval -- --retrieval-only     # retrieval metrics only (no LLM calls, < 1 cent)
 *   pnpm eval -- --runs=1             # one answer run instead of the default
 *   pnpm eval -- --only=q-001,q-061   # smoke test: just these questions, printed, no results file
 *   pnpm eval -- --flags=queryRewrite,hybridSearch   # these retrieval flags on, all others off
 *   pnpm eval -- --flags=rerank --rerank-model=rerank-v4.0-fast   # rerank with another model
 *                                                    # (default: the app's `retrievalFlags`)
 *
 * Runs against the Neon `dev` branch (`DATABASE_URL`) and refuses to touch production or the
 * test branch. Each run replaces the previous eval notebook, so runs are independent.
 *
 * Calls OpenAI: embeddings (a fraction of a cent), and for the answer metrics the generator
 * (Luna) and the judge (also Luna); the run prints and records what it cost. Document content comes
 * from the local cache, never from Firecrawl or Supadata.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import {
  chunking,
  embeddingRequests,
  embeddings as embeddingModel,
  ingestion,
  llmModels,
  llmRequests,
  llmTasks,
  retrieval,
  rerankModels,
  rerankRequests,
  retrievalFlags,
  type RetrievalFlags,
} from '../../apps/server/src/config/index.js';
import { createDb } from '../../apps/server/src/db/client.js';
import { LlmError } from '../../apps/server/src/errors/llm-error.js';
import { notebooks, sources, users } from '../../apps/server/src/db/schema/index.js';
import { createOpenAiEmbeddings } from '../../apps/server/src/lib/embeddings/index.js';
import {
  createOpenAiLlm,
  type LlmProvider,
  type LlmUsage,
} from '../../apps/server/src/lib/llm/index.js';
import { createUnpdfParser } from '../../apps/server/src/lib/pdf/index.js';
import { createLogger } from '../../apps/server/src/logger.js';
import { countTokens } from '../../apps/server/src/pipelines/ingestion/tokens.js';
import { generateAnswer } from '../../apps/server/src/pipelines/retrieval/generate.js';
import { createCohereRerank } from '../../apps/server/src/lib/rerank/index.js';
import { runRetrieval } from '../../apps/server/src/pipelines/retrieval/pipeline.js';
import { rerankChunks } from '../../apps/server/src/pipelines/retrieval/rerank.js';
import { understandQuery } from '../../apps/server/src/pipelines/retrieval/understand.js';
import type { RetrievedChunk } from '../../apps/server/src/pipelines/retrieval/retrieve.js';
import { createIngestionRepository } from '../../apps/server/src/repositories/ingestion.repository.js';
import { createRetrievalRepository } from '../../apps/server/src/repositories/retrieval.repository.js';
import {
  createIngestionService,
  type StepAttempt,
} from '../../apps/server/src/services/ingestion.service.js';
import {
  canonicalYouTubeUrl,
  parseYouTubeVideoId,
} from '../../apps/server/src/services/source-identity.js';
import {
  answerMetrics,
  answerMetricsByCategory,
  averageMetrics,
  usageCost,
  type AnswerMetrics,
  type AnswerOutcome,
} from '../src/answers.js';
import { createCachedProviders } from '../src/cached-providers.js';
import { evalConfig, maxK } from '../src/config.js';
import { chunkDocument } from '../src/content.js';
import { datasetDir, readDocuments, sha256, type EvalDocument } from '../src/dataset.js';
import { metricsByCategory, retrievalMetrics, type QuestionOutcome } from '../src/metrics.js';
import {
  judgeCorrectness,
  judgeFaithfulness,
  readJudgePrompts,
  type JudgePrompts,
} from '../src/judge.js';
import { readQuestions, type Question } from '../src/questions.js';
import { isRelevant } from '../src/relevance.js';

/** `--retrieval-only`, `--runs=N`, `--only=<ids>`, `--flags=<names>`, `--rerank-model=<id>`. */
function parseArgs(argv: string[]) {
  const value = (name: string) =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const runsArg = value('runs');
  const runs = runsArg ? Number(runsArg) : evalConfig.answerRuns;
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer`);
  const only = value('only')
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const flagsArg = value('flags');
  const rerankModel = value('rerank-model') ?? rerankModels.default;
  if (!(rerankModels.candidates as readonly string[]).includes(rerankModel)) {
    throw new Error(`--rerank-model must be one of ${rerankModels.candidates.join(', ')}`);
  }
  return {
    rerankModel,
    answers: !argv.includes('--retrieval-only'),
    runs,
    only: only ?? null,
    flags: flagsArg === undefined ? retrievalFlags : parseFlags(flagsArg),
  };
}

/** `--flags=a,b`: exactly these on. An unknown name fails, so a typo can't run the baseline. */
function parseFlags(arg: string): RetrievalFlags {
  const names = arg
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const flags = Object.fromEntries(
    Object.keys(retrievalFlags).map((name) => [name, false]),
  ) as unknown as RetrievalFlags;
  for (const name of names) {
    if (!(name in flags)) {
      throw new Error(`--flags: unknown flag ${name} (known: ${Object.keys(flags).join(', ')})`);
    }
    flags[name as keyof RetrievalFlags] = true;
  }
  return flags;
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping the order of the results. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Token usage per API model, for the cost line. */
class UsageByModel {
  private readonly totals = new Map<string, LlmUsage & { calls: number }>();

  add(model: string, usage: LlmUsage) {
    const total = this.totals.get(model) ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      calls: 0,
    };
    total.inputTokens += usage.inputTokens;
    total.cachedInputTokens += usage.cachedInputTokens;
    total.outputTokens += usage.outputTokens;
    total.calls += 1;
    this.totals.set(model, total);
  }

  report() {
    return Object.fromEntries(
      [...this.totals].map(([model, usage]) => {
        const price = evalConfig.llmPrices[model];
        if (!price) throw new Error(`No price for model ${model} in evals/src/config.ts`);
        return [model, { ...usage, usd: Math.round(usageCost(usage, price) * 1e5) / 1e5 }];
      }),
    );
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from .env`);
  return value;
}

/** Host + database name, ignoring Neon's `-pooler` suffix, credentials and params. */
function databaseIdentity(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/-pooler(?=\.)/, '');
  return `${host}:${parsed.port || '5432'}${parsed.pathname}`;
}

/** The eval writes a notebook and chunks: never on production, and not on the test branch. */
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

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/**
 * "vector" for the baseline; each retrieval flag that is on is appended. Rerank is named by its
 * model (`…+rerank-v4.0-pro`), so the models can be compared side by side.
 */
function configLabel(flags: RetrievalFlags, rerankModel: string): string {
  const on = Object.entries(flags)
    .filter(([, enabled]) => enabled)
    .map(([name]) => (name === 'rerank' ? rerankModel : name));
  return ['vector', ...on].join('+');
}

/** The same text ingestion embeds for a chunk. */
const embeddingInput = (chunk: { contextHeader: string; content: string }) =>
  `${chunk.contextHeader}\n\n${chunk.content}`;

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const documents = await readDocuments();
  const allQuestions = await readQuestions();
  const questions = args.only
    ? allQuestions.filter((q) => args.only?.includes(q.id))
    : allQuestions;
  if (questions.length === 0) throw new Error('--only matched no question');

  const { db, pool } = createDb(evalDatabaseUrl());
  const logger = createLogger({ level: 'warn', pretty: false });
  const embeddings = createOpenAiEmbeddings({
    apiKey: requireEnv('OPENAI_API_KEY'),
    model: embeddingModel.model,
    dimensions: embeddingModel.dimensions,
    batchSize: embeddingRequests.batchSize,
    timeoutMs: embeddingRequests.timeoutMs,
  });
  const cached = createCachedProviders(documents.filter((d) => d.type !== 'TEXT'));
  const service = createIngestionService({
    repository: createIngestionRepository(db, ingestion.chunkInsertBatchSize),
    storage: cached.storage,
    pdf: createUnpdfParser(),
    scraper: cached.scraper,
    transcript: cached.transcript,
    embeddings,
    jobs: { send: () => Promise.resolve() },
    logger,
    chunking: { ...chunking, countTokens },
    // Unused here: the runner never sweeps.
    sweep: {
      processingTimeoutMinutes: ingestion.processingTimeoutMinutes,
      pendingResendMinutes: ingestion.pendingResendMinutes,
      batchSize: ingestion.sweepBatchSize,
    },
  });
  const retrievalRepository = createRetrievalRepository(db);
  // No call is made until a step uses it: query understanding (when its flags are on), answers
  // and the judge.
  const llm = createOpenAiLlm({
    apiKey: requireEnv('OPENAI_API_KEY'),
    models: llmModels,
    tasks: llmTasks,
    timeoutMs: llmRequests.timeoutMs,
    maxRetries: llmRequests.maxRetries,
  });
  const usage = new UsageByModel();
  const rerankUsage = { calls: 0, searchUnits: 0, latenciesMs: [] as number[] };
  // Questions are retrieved one at a time, so spacing the calls keeps under the key's limit.
  let lastRerankAt = 0;
  const rerankPacer = async () => {
    const gapMs = 60_000 / evalConfig.rerankCallsPerMinute + 100;
    const wait = lastRerankAt + gapMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRerankAt = Date.now();
  };
  const reranker = args.flags.rerank
    ? createCohereRerank({
        apiKey: requireEnv('COHERE_API_KEY'),
        model: args.rerankModel,
        timeoutMs: evalConfig.rerankTimeoutMs,
        maxTokensPerDoc: rerankRequests.maxTokensPerDoc,
      })
    : null;

  try {
    // ── A fresh eval notebook ──
    await db
      .insert(users)
      .values({ clerkUserId: evalConfig.evalUserClerkId })
      .onConflictDoNothing();
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkUserId, evalConfig.evalUserClerkId));
    if (!user) throw new Error('eval user missing');
    await db.delete(notebooks).where(eq(notebooks.userId, user.id));
    const [notebook] = await db
      .insert(notebooks)
      .values({ userId: user.id, title: evalConfig.notebookTitle, kind: 'SOURCE' })
      .returning({ id: notebooks.id });
    if (!notebook) throw new Error('eval notebook not created');

    // ── Ingest every document through the real ingestion steps ──
    const documentBySource = new Map<string, EvalDocument>();
    let embeddedTokens = 0;
    let chunkCount = 0;
    for (const document of documents) {
      process.stdout.write(`ingesting ${document.id} … `);
      const sourceId = await insertSource(document, user.id, notebook.id);
      documentBySource.set(sourceId, document);

      // One job run per source, as Inngest would do it: a step that throws (a transient failure)
      // is retried, and only its last attempt marks the source failed.
      const ref = { userId: user.id, sourceId, runId: `eval-${randomUUID()}` };
      for (const [step, run] of [
        ['start', () => service.start(ref)],
        ['extract', (attempt: StepAttempt) => service.extract(ref, attempt)],
        ['chunk', (attempt: StepAttempt) => service.chunk(ref, attempt)],
        ['embed-and-commit', (attempt: StepAttempt) => service.embedAndCommit(ref, attempt)],
      ] as const) {
        const result = await runStep(document.id, step, run);
        if (result.status !== 'ok') {
          throw new Error(`${document.id}: ${step} stopped: ${JSON.stringify(result)}`);
        }
        if (step === 'embed-and-commit') {
          chunkCount += result.chunkCount ?? 0;
          console.log(`${String(result.chunkCount ?? 0)} chunks`);
        }
      }
      const localChunks = await chunkDocument(document);
      embeddedTokens += localChunks.reduce((sum, c) => sum + countTokens(embeddingInput(c)), 0);
    }

    // ── Ask every question ──
    const outcomes: (QuestionOutcome & {
      id: string;
      topScore: number | null;
      queries: string[];
      routedPastRetrieval: boolean;
      rerankTopScore: number | null;
      gated: boolean;
      failedSteps: string[];
      retrieved: ReturnType<typeof describe>[];
    })[] = [];
    const retrievedByQuestion = new Map<string, { retrieved: boolean; chunks: RetrievedChunk[] }>();
    for (const question of questions) {
      embeddedTokens += countTokens(question.question);
      const {
        retrieved,
        queries,
        failed,
        steps,
        gated,
        gateScore,
        chunks: results,
      } = await runRetrieval(
        {
          userId: user.id,
          notebookId: notebook.id,
          question: question.question,
          history: question.history,
          topK: maxK,
        },
        {
          flags: args.flags,
          embeddings,
          vectorSearch: (params) => retrievalRepository.vectorSearch(params),
          keywordSearch: (params) => retrievalRepository.keywordSearch(params),
          ...(reranker
            ? {
                rerank: async (rerankInput) => {
                  await rerankPacer();
                  const started = performance.now();
                  const chunks = await rerankChunks(rerankInput, {
                    reranker,
                    onSearchUnits: (units) => {
                      rerankUsage.searchUnits += units;
                    },
                  });
                  rerankUsage.calls += 1;
                  rerankUsage.latenciesMs.push(Math.round(performance.now() - started));
                  return chunks;
                },
              }
            : {}),
          understandQuery: async (understandInput) => {
            const understood = await understandQuery(understandInput, { llm });
            usage.add(understood.model, understood.usage);
            return understood;
          },
          onStepFailed: (step, error) => {
            console.warn(`\n${question.id}: ${step} failed, skipped: ${String(error)}`);
          },
        },
      );
      retrievedByQuestion.set(question.id, { retrieved, chunks: results });
      const scored = results.map((result) =>
        describe(result, documentBySource, question.expectedLocations),
      );
      outcomes.push({
        id: question.id,
        category: question.category,
        answerable: question.answerable,
        relevantRanks: scored.filter((r) => r.relevant).map((r) => r.rank),
        topScore: scored[0]?.score ?? null,
        queries,
        routedPastRetrieval: !retrieved,
        failedSteps: failed,
        // The top rerank score, kept when the gate removed the chunks: what the gate is tuned on.
        rerankTopScore: steps.rerank ? (gateScore ?? results[0]?.score ?? null) : null,
        gated,
        retrieved: scored,
      });
    }

    // ── Answers, graded by the judge ──
    const answers = args.answers
      ? await runAnswers({
          llm,
          questions,
          retrievedByQuestion,
          documentBySource,
          runs: args.runs,
          usage,
        })
      : null;

    // ── Metrics and the results file ──
    const overall = retrievalMetrics(outcomes, evalConfig.hitRateKs);
    const byCategory = metricsByCategory(outcomes, evalConfig.hitRateKs);
    const label = configLabel(args.flags, args.rerankModel);
    const date = new Date().toISOString().slice(0, 10);
    const results = {
      date,
      gitCommit: git('rev-parse', '--short', 'HEAD'),
      // The whole repo (the runner measures server code too), not the cwd; results and the local
      // `.claude/` folder don't count.
      gitDirty:
        git(
          'status',
          '--porcelain',
          '--',
          ':(top)',
          ':(top,exclude)evals/results',
          ':(top,exclude).claude',
        ).length > 0,
      config: { label, ...args.flags },
      models: {
        embedding: embeddings.model,
        ...(reranker ? { rerank: reranker.model } : {}),
        ...(answers
          ? {
              generator: llmModels[llmTasks.chatAnswer.tier],
              judge: llmModels[llmTasks.evalJudge.tier],
            }
          : {}),
      },
      chunking: { targetTokens: chunking.targetTokens, overlapRatio: chunking.overlapRatio },
      dataset: {
        documents: documents.length,
        chunks: chunkCount,
        questions: questions.length,
        answerable: overall.questions,
      },
      retrieval: { ...overall.hitRate, mrr: overall.mrr, mrrCutoff: maxK },
      answers: answers
        ? {
            runs: args.runs,
            contextChunks: retrieval.rerankTopK,
            ...answers.metrics,
          }
        : null,
      answersByCategory: answers?.byCategory ?? null,
      gateSweep: gateSweep(outcomes),
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([category, m]) => [
          category,
          { questions: m.questions, ...m.hitRate, mrr: m.mrr },
        ]),
      ),
      cost: costReport(
        embeddedTokens,
        usage,
        reranker ? { model: reranker.model, ...rerankUsage } : null,
      ),
      ...(reranker ? { rerankLatencyMs: latencySummary(rerankUsage.latenciesMs) } : {}),
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      questions: outcomes.map((outcome) => ({
        id: outcome.id,
        category: outcome.category,
        firstRelevantRank: outcome.relevantRanks[0] ?? null,
        topScore: outcome.topScore,
        queries: outcome.queries,
        routedPastRetrieval: outcome.routedPastRetrieval,
        rerankTopScore: outcome.rerankTopScore,
        gated: outcome.gated,
        failedSteps: outcome.failedSteps,
        retrieved: outcome.retrieved,
        ...(answers ? { answers: answers.byQuestion.get(outcome.id) ?? [] } : {}),
      })),
    };

    if (args.only) {
      // A smoke test isn't a result: print what the file would hold.
      console.log(JSON.stringify(results.questions, null, 2));
    } else {
      await mkdir(evalConfig.resultsDir, { recursive: true });
      // A retrieval-only run must not overwrite the same day's full run of this config.
      const suffix = answers ? '' : '-retrieval';
      const path = `${evalConfig.resultsDir}${date}-${label}${suffix}.json`;
      await writeFile(path, `${JSON.stringify(results, null, 2)}\n`);
      console.log(`wrote ${path}`);
    }

    console.log(`\n${label} · ${String(overall.questions)} answerable questions`);
    console.table({ overall: results.retrieval, ...results.byCategory });
    if (results.gateSweep) {
      console.log('relevance gate sweep (top rerank score < threshold → refuse)');
      console.table(results.gateSweep.rows);
    }
    if (answers) {
      const { perRun: _perRun, ...averaged } = answers.metrics;
      console.log(`answers (mean of ${String(args.runs)} runs)`);
      console.table({ overall: averaged, ...answers.byCategory });
    }
    console.log(`cost ≈ $${String(results.cost.usd)} · ${String(results.durationSeconds)}s`);
    if (results.rerankLatencyMs) {
      console.log(`rerank latency (ms): ${JSON.stringify(results.rerankLatencyMs)}`);
    }
  } finally {
    await pool.end();
  }

  /** Runs a job step with Inngest's attempts (`ingestion.retries` after the first). */
  async function runStep<T>(
    documentId: string,
    step: string,
    run: (attempt: StepAttempt) => Promise<T>,
  ): Promise<T> {
    const attempts = ingestion.retries + 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run({ isLastAttempt: attempt === attempts });
      } catch (error) {
        if (attempt === attempts) throw error;
        console.warn(`\n${documentId}: ${step} attempt ${String(attempt)} failed; retrying`);
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
    }
  }

  /** Inserts a document as a `PENDING` source, the way the sources API would. */
  async function insertSource(document: EvalDocument, userId: string, notebookId: string) {
    const common = { userId, notebookId, title: document.title, status: 'PENDING' as const };
    let values;
    switch (document.type) {
      case 'PDF': {
        const storageKey = `users/${userId}/uploads/${randomUUID()}.pdf`;
        cached.registerPdf(storageKey, document);
        values = {
          ...common,
          type: 'PDF' as const,
          storageKey,
          contentHash: document.sha256 ?? '',
        };
        break;
      }
      case 'WEBSITE':
        values = {
          ...common,
          type: 'WEBSITE' as const,
          url: document.url,
          contentHash: sha256(document.url),
        };
        break;
      case 'YOUTUBE': {
        const videoId = parseYouTubeVideoId(document.url);
        if (videoId === null) throw new Error(`${document.id}: not a YouTube URL`);
        const url = canonicalYouTubeUrl(videoId);
        values = {
          ...common,
          type: 'YOUTUBE' as const,
          url,
          contentHash: sha256(url),
          metadata: { videoId },
        };
        break;
      }
      case 'TEXT': {
        const text = (await readFile(`${datasetDir}${document.file}`, 'utf8')).trim();
        values = {
          ...common,
          type: 'TEXT' as const,
          extractedText: text,
          contentHash: sha256(text),
        };
        break;
      }
    }
    const [row] = await db.insert(sources).values(values).returning({ id: sources.id });
    if (!row) throw new Error(`${document.id}: source not created`);
    return row.id;
  }
}

/** One retrieved chunk as the results file records it. */
function describe(
  result: RetrievedChunk,
  documentBySource: Map<string, EvalDocument>,
  expected: Parameters<typeof isRelevant>[1],
) {
  const documentId = documentBySource.get(result.sourceId)?.id ?? 'unknown';
  const { pageNumber, startSeconds, endSeconds, headingPath } = result.location;
  return {
    rank: result.rank,
    documentId,
    chunkIndex: result.chunkIndex,
    location: { pageNumber, startSeconds, endSeconds, headingPath },
    score: Math.round(result.score * 10_000) / 10_000,
    relevant: isRelevant(
      { documentId, pageNumber, startSeconds, endSeconds, headingPath },
      expected,
    ),
  };
}

function costReport(
  embeddingTokens: number,
  usage: UsageByModel,
  rerank: { model: string; calls: number; searchUnits: number } | null,
) {
  const embeddingUsd =
    Math.round((embeddingTokens / 1e6) * evalConfig.embeddingUsdPerMillionTokens * 1e5) / 1e5;
  const llm = usage.report();
  const llmUsd = Object.values(llm).reduce((sum, m) => sum + m.usd, 0);
  let rerankUsd = 0;
  if (rerank) {
    const price = evalConfig.rerankPricesPerThousandSearches[rerank.model];
    if (price === undefined) throw new Error(`No price for ${rerank.model} in evals/src/config.ts`);
    rerankUsd = Math.round((rerank.searchUnits / 1000) * price * 1e5) / 1e5;
  }
  return {
    embeddingTokens,
    embeddingUsd,
    llm,
    ...(rerank
      ? {
          rerank: {
            model: rerank.model,
            calls: rerank.calls,
            searchUnits: rerank.searchUnits,
            usd: rerankUsd,
          },
        }
      : {}),
    usd: Math.round((embeddingUsd + llmUsd + rerankUsd) * 1e5) / 1e5,
  };
}

/**
 * What the relevance gate would do at each threshold, from the top rerank scores alone (no LLM):
 * the share of unanswerable questions it refuses (higher is better) and of answerable ones it
 * wrongly refuses (lower is better). Null when rerank didn't run.
 */
function gateSweep(outcomes: { answerable: boolean; rerankTopScore: number | null }[]) {
  const scored = outcomes.filter((o) => o.rerankTopScore !== null);
  if (scored.length === 0) return null;
  const unanswerable = scored.filter((o) => !o.answerable);
  const answerable = scored.filter((o) => o.answerable);
  const share = (items: typeof scored, threshold: number) =>
    items.length === 0
      ? null
      : Math.round(
          (items.filter((o) => (o.rerankTopScore ?? 0) < threshold).length / items.length) * 1e4,
        ) / 1e4;
  const rows = Array.from({ length: 13 }, (_, i) => Math.round((0.3 + i * 0.05) * 100) / 100).map(
    (threshold) => ({
      threshold,
      refusalAccuracy: share(unanswerable, threshold),
      falseRefusalRate: share(answerable, threshold),
    }),
  );
  return {
    questions: scored.length,
    withoutRerankScore: outcomes.length - scored.length,
    rows,
  };
}

/** Median and 95th percentile of the rerank calls' latency. */
function latencySummary(latencies: number[]) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
  return { calls: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
}

interface AnswerRunInput {
  llm: LlmProvider;
  questions: Question[];
  retrievedByQuestion: Map<string, { retrieved: boolean; chunks: RetrievedChunk[] }>;
  documentBySource: Map<string, EvalDocument>;
  runs: number;
  usage: UsageByModel;
}

/**
 * Answers every question `runs` times through the real generation step (the top
 * `retrieval.rerankTopK` chunks, as chat uses them), then grades each answer: faithfulness and
 * correctness by the judge, citation accuracy and refusals in code.
 */
async function runAnswers({
  llm,
  questions,
  retrievedByQuestion,
  documentBySource,
  runs,
  usage,
}: AnswerRunInput) {
  const prompts = await readJudgePrompts();
  const perRun: AnswerMetrics[] = [];
  const allOutcomes: AnswerOutcome[][] = [];
  const byQuestion = new Map<string, unknown[]>();

  for (let run = 1; run <= runs; run += 1) {
    let done = 0;
    const graded = await mapLimit(questions, evalConfig.answerConcurrency, async (question) => {
      const result = await withRetries(question.id, () =>
        answerAndGrade(llm, prompts, question, retrievedByQuestion, documentBySource, usage),
      );
      done += 1;
      process.stdout.write(
        `\ranswers run ${String(run)}/${String(runs)}: ${String(done)}/${String(questions.length)}`,
      );
      return result;
    });
    process.stdout.write('\n');
    const outcomes = graded.map((g) => g.outcome);
    allOutcomes.push(outcomes);
    perRun.push(answerMetrics(outcomes));
    graded.forEach((g, index) => {
      const id = questions[index]?.id ?? '';
      byQuestion.set(id, [...(byQuestion.get(id) ?? []), { run, ...g.record }]);
    });
  }

  // Per category: each run's metrics, then averaged like the overall ones.
  const categories = [...new Set(questions.map((q) => q.category))];
  const byCategory = Object.fromEntries(
    categories.map((category) => [
      category,
      averageMetrics(
        allOutcomes.map(
          (outcomes) => answerMetricsByCategory(outcomes)[category] ?? answerMetrics([]),
        ),
      ),
    ]),
  );
  return { metrics: { ...averageMetrics(perRun), perRun }, byCategory, byQuestion };
}

/** Retries `fn` on a retryable `LlmError`, up to `evalConfig.questionAttempts` attempts. */
async function withRetries<T>(id: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (
        !(error instanceof LlmError && error.retryable) ||
        attempt >= evalConfig.questionAttempts
      ) {
        throw error;
      }
      console.warn(`\n${id}: attempt ${String(attempt)} failed (${error.message}); retrying`);
    }
  }
}

async function answerAndGrade(
  llm: LlmProvider,
  prompts: JudgePrompts,
  question: Question,
  retrievedByQuestion: AnswerRunInput['retrievedByQuestion'],
  documentBySource: Map<string, EvalDocument>,
  usage: UsageByModel,
) {
  const found = retrievedByQuestion.get(question.id);
  const chunks = (found?.chunks ?? []).slice(0, retrieval.rerankTopK);
  const stream = generateAnswer(
    {
      question: question.question,
      chunks,
      history: question.history,
      retrieved: found?.retrieved ?? true,
    },
    { llm, countTokens },
  );
  // Read the stream to the end, as chat does; the result has the full text.
  for await (const _part of stream.textStream);
  const answer = await stream.result;
  if (answer.model && answer.usage) usage.add(answer.model, answer.usage);

  // Citation accuracy in code: does each cited chunk sit at an expected location?
  const byMarker = new Map(stream.sources.map((source) => [source.marker, source.chunk]));
  const citations = answer.citations.map((citation) => {
    const chunk = byMarker.get(citation.marker);
    const described = chunk ? describe(chunk, documentBySource, question.expectedLocations) : null;
    return {
      marker: citation.marker,
      documentId: described?.documentId ?? 'unknown',
      location: described?.location ?? null,
      relevant: described?.relevant ?? false,
    };
  });

  let faithfulness = null;
  if (!answer.refused) {
    const cited = answer.citations.flatMap((citation) => {
      const chunk = byMarker.get(citation.marker);
      return chunk
        ? [{ marker: citation.marker, title: chunk.sourceTitle, content: chunk.content }]
        : [];
    });
    const judged = await judgeFaithfulness(llm, prompts, {
      question: question.question,
      answer: answer.text,
      sources: cited,
    });
    usage.add(judged.model, judged.usage);
    faithfulness = judged.verdict;
  }

  let correctness = null;
  if (question.answerable) {
    if (answer.refused) {
      // The rubric's 1 ("says the information is not available"), without a judge call.
      correctness = { score: 1, reason: 'Refused an answerable question.' };
    } else {
      const judged = await judgeCorrectness(llm, prompts, {
        question: question.question,
        expectedAnswer: question.expectedAnswer,
        answer: answer.text,
      });
      usage.add(judged.model, judged.usage);
      correctness = judged.verdict;
    }
  }

  const outcome: AnswerOutcome = {
    category: question.category,
    answerable: question.answerable,
    refused: answer.refused,
    claims: faithfulness ? faithfulness.claims.map((c) => ({ supported: c.supported })) : null,
    correctness: correctness?.score ?? null,
    citations: citations.map((c) => ({ relevant: c.relevant })),
  };
  const record = {
    text: answer.text,
    refused: answer.refused,
    // Invented `[n]`s the citation check removed (step 8).
    removedMarkers: answer.removedMarkers,
    citations,
    faithfulness: faithfulness && {
      supported: faithfulness.claims.filter((c) => c.supported).length,
      claims: faithfulness.claims,
    },
    correctness,
  };
  return { outcome, record };
}

await main();
