import { InngestTestEngine, mockCtx } from '@inngest/test';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { chunking, ingestion } from '../../src/config/index.js';
import { notebooks, sourceChunks, sources, users } from '../../src/db/schema/index.js';
import { IngestionError } from '../../src/errors/ingestion-error.js';
import { createProcessSourceFunction } from '../../src/inngest/process-source.js';
import { createInngestClient } from '../../src/lib/jobs/index.js';
import { createUnpdfParser } from '../../src/lib/pdf/index.js';
import { countTokens } from '../../src/pipelines/ingestion/tokens.js';
import { createIngestionRepository } from '../../src/repositories/ingestion.repository.js';
import { createIngestionService } from '../../src/services/ingestion.service.js';
import { createFakeEmbeddings } from '../fakes/embeddings.js';
import { createFakeScraper, createFakeTranscript } from '../fakes/extraction.js';
import { createFakeJobs } from '../fakes/jobs.js';
import { createFakeStorage } from '../fakes/storage.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const db = getTestDb();
const logger = pino({ level: 'silent' });

let scraper: ReturnType<typeof createFakeScraper>;
let engine: InngestTestEngine;
let ref: { sourceId: string; userId: string };

/** Runs the real Inngest function for a `source/created` event. */
function run(data: unknown = ref, attempt = 0) {
  return engine.execute({
    events: [{ name: 'source/created', data: data as Record<string, unknown> }],
    transformCtx: (ctx) => ({ ...mockCtx(ctx), attempt }),
  });
}

async function status() {
  const [row] = await db
    .select({ status: sources.status, errorCode: sources.errorCode })
    .from(sources)
    .where(eq(sources.id, ref.sourceId));
  return row;
}

beforeEach(async () => {
  await truncateAllTables();
  scraper = createFakeScraper();

  const service = createIngestionService({
    repository: createIngestionRepository(db, ingestion.chunkInsertBatchSize),
    storage: createFakeStorage().provider,
    pdf: createUnpdfParser(),
    scraper: scraper.provider,
    transcript: createFakeTranscript().provider,
    embeddings: createFakeEmbeddings().provider,
    jobs: createFakeJobs().provider,
    logger,
    chunking: { ...chunking, countTokens },
    sweep: { processingTimeoutMinutes: 15, pendingResendMinutes: 10, batchSize: 100 },
  });
  // Dev mode with a fetch that always fails: the client can never reach Inngest from a test.
  const client = createInngestClient({
    isDev: true,
    logger,
    fetch: () => Promise.reject(new Error('network is blocked in tests')),
  });
  engine = new InngestTestEngine({ function: createProcessSourceFunction(client, service) });

  const [user] = await db.insert(users).values({ clerkUserId: 'user_job' }).returning();
  if (!user) throw new Error('user not created');
  const [notebook] = await db
    .insert(notebooks)
    .values({ userId: user.id, title: 'ML', kind: 'SOURCE' })
    .returning();
  if (!notebook) throw new Error('notebook not created');
  const [source] = await db
    .insert(sources)
    .values({
      notebookId: notebook.id,
      userId: user.id,
      type: 'WEBSITE',
      title: 'example.com/a',
      url: 'https://example.com/a',
      contentHash: 'hash',
    })
    .returning();
  if (!source) throw new Error('source not created');
  ref = { sourceId: source.id, userId: user.id };
});

describe('processSource function', () => {
  it('runs the four steps in order and leaves the source READY', async () => {
    const { result, error, ctx } = await run();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: 'ok', chunkCount: 1 });
    expect(ctx.step.run.mock.calls.map(([id]) => id)).toEqual([
      'mark-processing',
      'extract',
      'chunk',
      'embed-and-commit',
    ]);
    expect(await status()).toEqual({ status: 'READY', errorCode: null });
    expect(await db.select().from(sourceChunks)).toHaveLength(1);
  });

  it('source not found → stops after the first step, without an error', async () => {
    await db.delete(sources).where(eq(sources.id, ref.sourceId));

    const { result, error, ctx } = await run();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: 'stopped', reason: 'not_found' });
    expect(ctx.step.run).toHaveBeenCalledTimes(1);
  });

  it('permanent failure → the run ends normally with the source FAILED (no retry)', async () => {
    scraper.failNext(IngestionError.permanent('PAGE_NOT_FOUND', "This page doesn't exist."));

    const { result, error, ctx } = await run();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: 'stopped', reason: 'failed', code: 'PAGE_NOT_FOUND' });
    expect(ctx.step.run.mock.calls.map(([id]) => id)).toEqual(['mark-processing', 'extract']);
    expect(await status()).toEqual({ status: 'FAILED', errorCode: 'PAGE_NOT_FOUND' });
  });

  it('transient failure before the last attempt → the step throws, so Inngest retries it', async () => {
    scraper.failNext(IngestionError.transient('The website took too long to respond.'));

    const { result, error } = await run(ref, 0);

    expect(result).toBeUndefined();
    expect(error).toMatchObject({ message: 'The website took too long to respond.' });
    expect(await status()).toEqual({ status: 'PROCESSING', errorCode: null });
  });

  it('transient failure on the last attempt → the source is FAILED instead of thrown', async () => {
    scraper.failNext(IngestionError.transient('The website took too long to respond.'));

    const { result, error } = await run(ref, ingestion.retries);

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ status: 'stopped', code: 'SERVICE_UNAVAILABLE' });
    expect(await status()).toEqual({ status: 'FAILED', errorCode: 'SERVICE_UNAVAILABLE' });
  });

  it('an event without valid IDs is rejected before any step runs', async () => {
    const { error, ctx } = await run({ sourceId: 'not-a-uuid' });

    expect(error).toBeDefined();
    expect(ctx.step.run).not.toHaveBeenCalled();
    expect(await status()).toEqual({ status: 'PENDING', errorCode: null });
  });

  it('is configured with the retry, concurrency and throttle limits from config', () => {
    const fn = createProcessSourceFunction(
      createInngestClient({ isDev: true, logger }),
      {} as never,
    );

    expect(fn.opts).toMatchObject({
      id: 'process-source',
      retries: ingestion.retries,
      concurrency: [
        { limit: ingestion.concurrency },
        { limit: ingestion.concurrencyPerUser, key: 'event.data.userId' },
      ],
      throttle: ingestion.throttle,
    });
    expect(fn.opts.triggers).toEqual([{ event: 'source/created' }, { event: 'source/reprocess' }]);
  });
});
