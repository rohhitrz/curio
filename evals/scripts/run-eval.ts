/**
 * The eval runner (build plan 4.3): ingests the golden dataset into an eval notebook through the
 * real ingestion service, asks every question through the real retrieval module, and writes the
 * retrieval metrics to `evals/results/<date>-<config>.json` (test plan §6.3, §6.6).
 *
 *   pnpm eval
 *
 * Runs against the Neon `dev` branch (`DATABASE_URL`) and refuses to touch production or the
 * test branch. Each run replaces the previous eval notebook, so runs are independent.
 *
 * Calls the OpenAI embeddings API (a fraction of a cent per run): document content comes from
 * the local cache, never from Firecrawl or Supadata.
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
  retrievalFlags,
} from '../../apps/server/src/config/index.js';
import { createDb } from '../../apps/server/src/db/client.js';
import { notebooks, sources, users } from '../../apps/server/src/db/schema/index.js';
import { createOpenAiEmbeddings } from '../../apps/server/src/lib/embeddings/index.js';
import { createUnpdfParser } from '../../apps/server/src/lib/pdf/index.js';
import { createLogger } from '../../apps/server/src/logger.js';
import { countTokens } from '../../apps/server/src/pipelines/ingestion/tokens.js';
import {
  retrieve,
  type RetrievedChunk,
} from '../../apps/server/src/pipelines/retrieval/retrieve.js';
import { createIngestionRepository } from '../../apps/server/src/repositories/ingestion.repository.js';
import { createRetrievalRepository } from '../../apps/server/src/repositories/retrieval.repository.js';
import { createIngestionService } from '../../apps/server/src/services/ingestion.service.js';
import {
  canonicalYouTubeUrl,
  parseYouTubeVideoId,
} from '../../apps/server/src/services/source-identity.js';
import { createCachedProviders } from '../src/cached-providers.js';
import { evalConfig, maxK } from '../src/config.js';
import { chunkDocument } from '../src/content.js';
import { datasetDir, readDocuments, sha256, type EvalDocument } from '../src/dataset.js';
import { metricsByCategory, retrievalMetrics, type QuestionOutcome } from '../src/metrics.js';
import { readQuestions } from '../src/questions.js';
import { isRelevant } from '../src/relevance.js';

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

/** "vector" for the baseline; each retrieval flag that is on is appended. */
function configLabel(): string {
  const on = Object.entries(retrievalFlags)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  return ['vector', ...on].join('+');
}

/** The same text ingestion embeds for a chunk. */
const embeddingInput = (chunk: { contextHeader: string; content: string }) =>
  `${chunk.contextHeader}\n\n${chunk.content}`;

async function main() {
  const startedAt = Date.now();
  const documents = await readDocuments();
  const questions = await readQuestions();

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

      const ref = { userId: user.id, sourceId };
      const attempt = { isLastAttempt: true };
      for (const [step, run] of [
        ['start', () => service.start(ref)],
        ['extract', () => service.extract(ref, attempt)],
        ['chunk', () => service.chunk(ref, attempt)],
        ['embed-and-commit', () => service.embedAndCommit(ref, attempt)],
      ] as const) {
        const result = await run();
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
    const outcomes: (QuestionOutcome & Record<string, unknown>)[] = [];
    for (const question of questions) {
      embeddedTokens += countTokens(question.question);
      const results = await retrieve(
        { userId: user.id, notebookId: notebook.id, query: question.question, limit: maxK },
        { embeddings, vectorSearch: (params) => retrievalRepository.vectorSearch(params) },
      );
      const scored = results.map((result) =>
        describe(result, documentBySource, question.expectedLocations),
      );
      outcomes.push({
        id: question.id,
        category: question.category,
        answerable: question.answerable,
        relevantRanks: scored.filter((r) => r.relevant).map((r) => r.rank),
        topScore: scored[0]?.score ?? null,
        retrieved: scored,
      });
    }

    // ── Metrics and the results file ──
    const overall = retrievalMetrics(outcomes, evalConfig.hitRateKs);
    const byCategory = metricsByCategory(outcomes, evalConfig.hitRateKs);
    const label = configLabel();
    const date = new Date().toISOString().slice(0, 10);
    const results = {
      date,
      gitCommit: git('rev-parse', '--short', 'HEAD'),
      gitDirty: git('status', '--porcelain', '--', '.', ':!evals/results').length > 0,
      config: { label, ...retrievalFlags },
      models: { embedding: embeddings.model },
      chunking: { targetTokens: chunking.targetTokens, overlapRatio: chunking.overlapRatio },
      dataset: {
        documents: documents.length,
        chunks: chunkCount,
        questions: questions.length,
        answerable: overall.questions,
      },
      retrieval: { ...overall.hitRate, mrr: overall.mrr, mrrCutoff: maxK },
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([category, m]) => [
          category,
          { questions: m.questions, ...m.hitRate, mrr: m.mrr },
        ]),
      ),
      cost: {
        embeddingTokens: embeddedTokens,
        usd:
          Math.round((embeddedTokens / 1e6) * evalConfig.embeddingUsdPerMillionTokens * 1e5) / 1e5,
      },
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      questions: outcomes.map(({ id, category, relevantRanks, topScore, retrieved }) => ({
        id,
        category,
        firstRelevantRank: relevantRanks[0] ?? null,
        topScore,
        retrieved,
      })),
    };

    await mkdir(evalConfig.resultsDir, { recursive: true });
    const path = `${evalConfig.resultsDir}${date}-${label}.json`;
    await writeFile(path, `${JSON.stringify(results, null, 2)}\n`);

    console.log(`\n${label} · ${String(overall.questions)} answerable questions`);
    console.table({ overall: results.retrieval, ...results.byCategory });
    console.log(`cost ≈ $${String(results.cost.usd)} · ${String(results.durationSeconds)}s`);
    console.log(`wrote ${path}`);
  } finally {
    await pool.end();
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

await main();
