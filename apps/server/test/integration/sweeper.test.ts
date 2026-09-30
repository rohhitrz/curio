import { InngestTestEngine } from '@inngest/test';
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { chunking, ingestion } from '../../src/config/index.js';
import { notebooks, sources, users } from '../../src/db/schema/index.js';
import { createSweepStuckSourcesFunction } from '../../src/inngest/sweep-stuck-sources.js';
import { createInngestClient } from '../../src/lib/jobs/index.js';
import { createUnpdfParser } from '../../src/lib/pdf/index.js';
import { countTokens } from '../../src/pipelines/ingestion/tokens.js';
import { createIngestionRepository } from '../../src/repositories/ingestion.repository.js';
import {
  createIngestionService,
  type IngestionService,
} from '../../src/services/ingestion.service.js';
import { createFakeEmbeddings } from '../fakes/embeddings.js';
import { createFakeScraper, createFakeTranscript } from '../fakes/extraction.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { createFakeStorage } from '../fakes/storage.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const db = getTestDb();
const logger = pino({ level: 'silent' });

let jobs: FakeJobs;
let service: IngestionService;
let userId: string;
let notebookId: string;
let counter = 0;

type Status = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

/** A source in `status` whose clocks (`updated_at`, `processing_started_at`) are `minutes` old. */
async function sourceAged(status: Status, minutes: number): Promise<string> {
  const [row] = await db
    .insert(sources)
    .values({
      notebookId,
      userId,
      type: 'TEXT',
      title: `Source ${++counter}`,
      contentHash: `hash-${counter}`,
      status,
    })
    .returning({ id: sources.id });
  if (!row) throw new Error('source not created');
  // Raw SQL, because the ORM would stamp `updated_at` with the current time.
  await db.execute(sql`
    update sources
       set updated_at = now() - make_interval(mins => ${minutes}),
           processing_started_at = ${status === 'PROCESSING' ? sql`now() - make_interval(mins => ${minutes})` : sql`null`}
     where id = ${row.id}`);
  return row.id;
}

async function rowOf(sourceId: string) {
  const [row] = await db.select().from(sources).where(eq(sources.id, sourceId));
  return row;
}

beforeEach(async () => {
  await truncateAllTables();
  jobs = createFakeJobs();
  service = createIngestionService({
    repository: createIngestionRepository(db, ingestion.chunkInsertBatchSize),
    storage: createFakeStorage().provider,
    pdf: createUnpdfParser(),
    scraper: createFakeScraper().provider,
    transcript: createFakeTranscript().provider,
    embeddings: createFakeEmbeddings().provider,
    jobs: jobs.provider,
    logger,
    chunking: { ...chunking, countTokens },
    sweep: { processingTimeoutMinutes: 15, pendingResendMinutes: 10, batchSize: 2 },
  });

  const [user] = await db.insert(users).values({ clerkUserId: 'user_sweep' }).returning();
  if (!user) throw new Error('user not created');
  userId = user.id;
  const [notebook] = await db
    .insert(notebooks)
    .values({ userId, title: 'ML', kind: 'SOURCE' })
    .returning();
  if (!notebook) throw new Error('notebook not created');
  notebookId = notebook.id;
});

describe('sweeper: stuck in PROCESSING', () => {
  it('PROCESSING for more than 15 minutes → FAILED / TIMEOUT', async () => {
    const stuck = await sourceAged('PROCESSING', 16);

    expect(await service.sweep()).toEqual({ timedOut: 1, resent: 0 });

    expect(await rowOf(stuck)).toMatchObject({
      status: 'FAILED',
      errorCode: 'TIMEOUT',
      errorMessage: 'Processing timed out, please retry.',
    });
  });

  it('PROCESSING for less than 15 minutes is left alone', async () => {
    const running = await sourceAged('PROCESSING', 14);

    expect(await service.sweep()).toEqual({ timedOut: 0, resent: 0 });
    expect(await rowOf(running)).toMatchObject({ status: 'PROCESSING', errorCode: null });
  });

  it('old READY and FAILED sources are never touched', async () => {
    const ready = await sourceAged('READY', 600);
    const failed = await sourceAged('FAILED', 600);

    expect(await service.sweep()).toEqual({ timedOut: 0, resent: 0 });
    expect((await rowOf(ready))?.status).toBe('READY');
    expect((await rowOf(failed))?.status).toBe('FAILED');
    expect(jobs.sent).toEqual([]);
  });
});

describe('sweeper: stuck in PENDING', () => {
  it('PENDING for more than 10 minutes → its event is sent again, status unchanged', async () => {
    const stale = await sourceAged('PENDING', 11);

    expect(await service.sweep()).toEqual({ timedOut: 0, resent: 1 });

    expect(jobs.sent).toEqual([{ name: 'source/reprocess', data: { sourceId: stale, userId } }]);
    expect((await rowOf(stale))?.status).toBe('PENDING');
  });

  it('a freshly added PENDING source is left alone', async () => {
    await sourceAged('PENDING', 2);

    expect(await service.sweep()).toEqual({ timedOut: 0, resent: 0 });
    expect(jobs.sent).toEqual([]);
  });

  it('a re-sent source is not sent again by the next sweep', async () => {
    await sourceAged('PENDING', 30);

    await service.sweep();
    await service.sweep();

    expect(jobs.sent).toHaveLength(1);
  });

  it('re-sends at most one batch per sweep, oldest first', async () => {
    const newest = await sourceAged('PENDING', 20);
    const oldest = await sourceAged('PENDING', 60);
    const middle = await sourceAged('PENDING', 40);

    expect(await service.sweep()).toEqual({ timedOut: 0, resent: 2 });
    expect(jobs.sent.map((e) => e.data)).toEqual(
      expect.arrayContaining([
        { sourceId: oldest, userId },
        { sourceId: middle, userId },
      ]),
    );

    // The third one goes out with the next sweep.
    expect(await service.sweep()).toEqual({ timedOut: 0, resent: 1 });
    expect(jobs.sent.at(-1)?.data).toEqual({ sourceId: newest, userId });
  });

  it('a failed send is not counted and does not stop the others', async () => {
    await sourceAged('PENDING', 30);
    await sourceAged('PENDING', 40);
    jobs.failNextSend(new Error('inngest down'));

    expect(await service.sweep()).toEqual({ timedOut: 0, resent: 1 });
    expect(jobs.sent).toHaveLength(1);
  });
});

describe('sweepStuckSources function', () => {
  const createFunction = () =>
    createSweepStuckSourcesFunction(
      createInngestClient({
        isDev: true,
        logger,
        fetch: () => Promise.reject(new Error('network is blocked in tests')),
      }),
      service,
    );

  it('runs the sweep and reports what it did', async () => {
    await sourceAged('PROCESSING', 20);
    await sourceAged('PENDING', 20);

    const { result, error } = await new InngestTestEngine({ function: createFunction() }).execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ timedOut: 1, resent: 1 });
  });

  it('is scheduled with the cron from config and does not retry', () => {
    expect(createFunction().opts).toMatchObject({
      id: 'sweep-stuck-sources',
      retries: 0,
      triggers: [{ cron: ingestion.sweepCron }],
    });
  });
});
