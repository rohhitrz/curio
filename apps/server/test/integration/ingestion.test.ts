import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { chunking } from '../../src/config/index.js';
import { notebooks, sourceChunks, sources, users } from '../../src/db/schema/index.js';
import { IngestionError } from '../../src/errors/ingestion-error.js';
import type { EmbeddingsProvider } from '../../src/lib/embeddings/index.js';
import { createUnpdfParser } from '../../src/lib/pdf/index.js';
import { countTokens } from '../../src/pipelines/ingestion/tokens.js';
import {
  createIngestionRepository,
  type SourceRef,
} from '../../src/repositories/ingestion.repository.js';
import {
  createIngestionService,
  type IngestionDeps,
  type IngestionService,
} from '../../src/services/ingestion.service.js';
import { createFakeEmbeddings, fakeVector, type FakeEmbeddings } from '../fakes/embeddings.js';
import { createFakeScraper, createFakeTranscript } from '../fakes/extraction.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { createFakeStorage, type FakeStorage } from '../fakes/storage.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';
import { buildPdf } from '../helpers/pdf.js';

const db = getTestDb();
const VIDEO_ID = 'dQw4w9WgXcQ';
const RETRY = { isLastAttempt: false };
const LAST = { isLastAttempt: true };

let storage: FakeStorage;
let scraper: ReturnType<typeof createFakeScraper>;
let transcript: ReturnType<typeof createFakeTranscript>;
let embeddings: FakeEmbeddings;
let jobs: FakeJobs;
let service: IngestionService;
let userId: string;
let notebookId: string;

function createService(overrides: Partial<IngestionDeps> = {}) {
  return createIngestionService({
    // A batch of 2 makes a source with 3+ chunks use several INSERTs in the commit.
    repository: createIngestionRepository(db, 2),
    storage: storage.provider,
    pdf: createUnpdfParser(),
    scraper: scraper.provider,
    transcript: transcript.provider,
    embeddings: embeddings.provider,
    jobs: jobs.provider,
    logger: pino({ level: 'silent' }),
    chunking: { ...chunking, countTokens },
    sweep: { processingTimeoutMinutes: 15, pendingResendMinutes: 10, batchSize: 100 },
    ...overrides,
  });
}

type NewSource = Omit<typeof sources.$inferInsert, 'notebookId' | 'userId' | 'contentHash'> & {
  contentHash?: string;
};

async function addSource(values: NewSource): Promise<SourceRef> {
  const [row] = await db
    .insert(sources)
    .values({ contentHash: `hash-${values.title}`, ...values, notebookId, userId })
    .returning({ id: sources.id });
  if (!row) throw new Error('source not created');
  return { userId, sourceId: row.id };
}

const textSource = () =>
  addSource({
    type: 'TEXT',
    title: 'My notes',
    extractedText:
      '# Optimizers\n\nGradient descent minimizes a loss.\n\n## Momentum\n\nIt adds velocity.',
  });

const websiteSource = (title = 'example.com/articles/rag') =>
  addSource({ type: 'WEBSITE', title, url: 'https://www.example.com/articles/rag/' });

const youtubeSource = () =>
  addSource({
    type: 'YOUTUBE',
    title: `YouTube video ${VIDEO_ID}`,
    url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    metadata: { videoId: VIDEO_ID },
  });

async function pdfSource(pages: string[], contentHash?: string) {
  const file = buildPdf(pages);
  const storageKey = `users/${userId}/uploads/${crypto.randomUUID()}.pdf`;
  storage.putFile(storageKey, file);
  return addSource({
    type: 'PDF',
    title: 'Lecture',
    storageKey,
    contentHash: contentHash ?? createHash('sha256').update(file).digest('hex'),
    metadata: { fileSize: file.length },
  });
}

/** The job's steps in order, as the Inngest function runs them when nothing fails. */
async function runJob(ref: SourceRef, run: IngestionService = service) {
  const results = [await run.start(ref)];
  const steps = [
    () => run.extract(ref, RETRY),
    () => run.chunk(ref, RETRY),
    () => run.embedAndCommit(ref, RETRY),
  ];
  for (const step of steps) {
    if (results.at(-1)?.status !== 'ok') break;
    results.push(await step());
  }
  return results.at(-1);
}

async function sourceRow(ref: SourceRef) {
  const [row] = await db.select().from(sources).where(eq(sources.id, ref.sourceId));
  return row;
}

function chunksOf(ref: SourceRef) {
  return db
    .select()
    .from(sourceChunks)
    .where(eq(sourceChunks.sourceId, ref.sourceId))
    .orderBy(asc(sourceChunks.chunkIndex));
}

beforeEach(async () => {
  await truncateAllTables();
  storage = createFakeStorage();
  scraper = createFakeScraper({
    title: 'RAG explained',
    markdown: '# RAG explained\n\nRetrieval first.\n\n## Generation\n\nThen the model answers.',
  });
  transcript = createFakeTranscript();
  embeddings = createFakeEmbeddings();
  jobs = createFakeJobs();
  service = createService();

  const [user] = await db.insert(users).values({ clerkUserId: 'user_ingest' }).returning();
  if (!user) throw new Error('user not created');
  userId = user.id;
  const [notebook] = await db
    .insert(notebooks)
    .values({ userId, title: 'ML', kind: 'SOURCE' })
    .returning();
  if (!notebook) throw new Error('notebook not created');
  notebookId = notebook.id;
});

describe('process each source type', () => {
  it('TEXT → READY, chunks carry the heading path and offsets into the text', async () => {
    const ref = await textSource();

    expect(await runJob(ref)).toEqual({ status: 'ok', chunkCount: 2 });

    const source = await sourceRow(ref);
    expect(source).toMatchObject({
      status: 'READY',
      chunkCount: 2,
      embeddingModel: 'fake-embedding-model',
      errorCode: null,
      errorMessage: null,
      title: 'My notes',
      extractedLocations: { kind: 'markdown' },
    });
    expect(source?.processedAt).toBeInstanceOf(Date);
    expect(source?.processingStartedAt).toBeInstanceOf(Date);

    const chunks = await chunksOf(ref);
    expect(chunks.map((c) => [c.headingPath, c.contextHeader, c.content])).toEqual([
      ['Optimizers', 'My notes › Optimizers', 'Gradient descent minimizes a loss.'],
      ['Optimizers › Momentum', 'My notes › Optimizers › Momentum', 'It adds velocity.'],
    ]);
    for (const chunk of chunks) {
      expect(chunk.notebookId).toBe(notebookId);
      expect(source?.extractedText?.slice(chunk.charStart ?? 0, chunk.charEnd ?? 0)).toBe(
        chunk.content,
      );
      expect(chunk.tokenCount).toBe(countTokens(chunk.content));
      // Embedded with its context header in front.
      expect(chunk.embedding[0]).toBeCloseTo(
        fakeVector(`${chunk.contextHeader}\n\n${chunk.content}`)[0] ?? NaN,
        5,
      );
    }
  });

  it('WEBSITE → READY with the real title, scraped text saved, heading paths on chunks', async () => {
    const ref = await websiteSource();

    expect(await runJob(ref)).toMatchObject({ status: 'ok', chunkCount: 2 });

    expect(await sourceRow(ref)).toMatchObject({
      status: 'READY',
      title: 'RAG explained',
      extractedText:
        '# RAG explained\n\nRetrieval first.\n\n## Generation\n\nThen the model answers.',
    });
    const chunks = await chunksOf(ref);
    expect(chunks.map((c) => [c.headingPath, c.contextHeader])).toEqual([
      ['RAG explained', 'RAG explained'],
      ['RAG explained › Generation', 'RAG explained › Generation'],
    ]);
    expect(chunks.every((c) => c.pageNumber === null && c.startSeconds === null)).toBe(true);
  });

  it('YOUTUBE → READY with the real title, timestamps on chunks, length in metadata', async () => {
    const ref = await youtubeSource();

    expect(await runJob(ref)).toMatchObject({ status: 'ok', chunkCount: 1 });

    expect(await sourceRow(ref)).toMatchObject({
      status: 'READY',
      title: 'Example video',
      extractedText: 'Hello. Welcome.',
      metadata: { videoId: VIDEO_ID, durationSeconds: 600, language: 'en' },
    });
    expect(await chunksOf(ref)).toMatchObject([
      { content: 'Hello. Welcome.', startSeconds: 0, endSeconds: 5, pageNumber: null },
    ]);
  });

  it('PDF → READY, one chunk per page with its page number, user title kept', async () => {
    const ref = await pdfSource(['First page text.', '', 'Third page text.']);

    expect(await runJob(ref)).toMatchObject({ status: 'ok', chunkCount: 2 });

    const source = await sourceRow(ref);
    expect(source).toMatchObject({ status: 'READY', title: 'Lecture', chunkCount: 2 });
    expect(source?.metadata).toMatchObject({ pageCount: 3, fileHash: source?.contentHash });
    expect((await chunksOf(ref)).map((c) => [c.pageNumber, c.content, c.contextHeader])).toEqual([
      [1, 'First page text.', 'Lecture'],
      [3, 'Third page text.', 'Lecture'],
    ]);
  });

  it('a title the user typed is not replaced by the page title', async () => {
    const ref = await websiteSource('My reading list');

    await runJob(ref);

    expect((await sourceRow(ref))?.title).toBe('My reading list');
    expect((await chunksOf(ref))[0]?.contextHeader).toBe('My reading list › RAG explained');
  });
});

describe('idempotency', () => {
  it('running the same job twice → same chunks, no duplicates', async () => {
    const ref = await textSource();

    await runJob(ref);
    const first = await chunksOf(ref);
    expect(await runJob(ref)).toEqual({ status: 'ok', chunkCount: 2 });
    const second = await chunksOf(ref);

    expect(second).toHaveLength(first.length);
    expect(second.map((c) => [c.chunkIndex, c.content])).toEqual(
      first.map((c) => [c.chunkIndex, c.content]),
    );
    expect(await sourceRow(ref)).toMatchObject({ status: 'READY', chunkCount: 2 });
  });

  it('reprocessing replaces the old chunks with the new content', async () => {
    const ref = await websiteSource();
    await runJob(ref);

    scraper = createFakeScraper({ title: 'RAG explained', markdown: 'The page changed.' });
    const result = await runJob(ref, createService());

    expect(result).toEqual({ status: 'ok', chunkCount: 1 });
    expect((await chunksOf(ref)).map((c) => c.content)).toEqual(['The page changed.']);
    expect(await sourceRow(ref)).toMatchObject({ status: 'READY', chunkCount: 1 });
  });

  it('a retried commit step writes the same chunks once', async () => {
    const ref = await textSource();
    await service.start(ref);
    await service.extract(ref, RETRY);
    await service.embedAndCommit(ref, RETRY);

    // The step ran, but suppose its result never reached Inngest: it runs again.
    expect(await service.embedAndCommit(ref, RETRY)).toEqual({
      status: 'stopped',
      reason: 'not_found',
    });
    expect(await chunksOf(ref)).toHaveLength(2);
    expect(await sourceRow(ref)).toMatchObject({ status: 'READY' });
  });
});

describe('transient errors', () => {
  it('the scraper times out twice, then works → retried → READY', async () => {
    const ref = await websiteSource();
    scraper.failNext(IngestionError.transient('slow'), IngestionError.transient('slow'));
    await service.start(ref);

    await expect(service.extract(ref, RETRY)).rejects.toMatchObject({ retryable: true });
    expect(await sourceRow(ref)).toMatchObject({ status: 'PROCESSING', errorCode: null });
    await expect(service.extract(ref, RETRY)).rejects.toMatchObject({ retryable: true });
    expect(await service.extract(ref, RETRY)).toEqual({ status: 'ok' });
    await service.chunk(ref, RETRY);
    await service.embedAndCommit(ref, RETRY);

    expect(await sourceRow(ref)).toMatchObject({ status: 'READY', chunkCount: 2 });
    expect(scraper.calls).toHaveLength(3);
  });

  it('still failing on the last attempt → FAILED with the message, not left PROCESSING', async () => {
    const ref = await websiteSource();
    scraper.failNext(IngestionError.transient('The website took too long to respond.'));
    await service.start(ref);

    const result = await service.extract(ref, LAST);

    expect(result).toEqual({ status: 'stopped', reason: 'failed', code: 'SERVICE_UNAVAILABLE' });
    expect(await sourceRow(ref)).toMatchObject({
      status: 'FAILED',
      errorCode: 'SERVICE_UNAVAILABLE',
      errorMessage: 'The website took too long to respond.',
    });
  });

  it('the embeddings service is down once, then works → READY', async () => {
    const ref = await textSource();
    embeddings.failNext(IngestionError.transient('busy'));
    await service.start(ref);
    await service.extract(ref, RETRY);

    await expect(service.embedAndCommit(ref, RETRY)).rejects.toMatchObject({ retryable: true });
    expect(await chunksOf(ref)).toEqual([]);
    expect(await service.embedAndCommit(ref, RETRY)).toEqual({ status: 'ok', chunkCount: 2 });
  });
});

describe('permanent errors', () => {
  it('scanned PDF → FAILED immediately with NO_TEXT, no retry', async () => {
    const ref = await pdfSource(['', '']);
    await service.start(ref);

    const result = await service.extract(ref, RETRY);

    expect(result).toEqual({ status: 'stopped', reason: 'failed', code: 'NO_TEXT' });
    const source = await sourceRow(ref);
    expect(source).toMatchObject({ status: 'FAILED', errorCode: 'NO_TEXT' });
    expect(source?.errorMessage).toContain('no selectable text');
    expect(await chunksOf(ref)).toEqual([]);
  });

  it('video without a transcript → FAILED with NO_TRANSCRIPT after one provider call', async () => {
    const ref = await youtubeSource();
    transcript.failNext(IngestionError.permanent('NO_TRANSCRIPT', 'This video has no captions.'));

    expect(await runJob(ref)).toEqual({
      status: 'stopped',
      reason: 'failed',
      code: 'NO_TRANSCRIPT',
    });
    expect(await sourceRow(ref)).toMatchObject({
      status: 'FAILED',
      errorCode: 'NO_TRANSCRIPT',
      errorMessage: 'This video has no captions.',
    });
    expect(transcript.calls).toHaveLength(1);
  });

  it('404 page → FAILED with PAGE_NOT_FOUND, and the job stops before embedding', async () => {
    const ref = await websiteSource();
    scraper.failNext(IngestionError.permanent('PAGE_NOT_FOUND', "This page doesn't exist."));

    await runJob(ref);

    expect(await sourceRow(ref)).toMatchObject({ status: 'FAILED', errorCode: 'PAGE_NOT_FOUND' });
    expect(scraper.calls).toHaveLength(1);
    expect(embeddings.calls).toEqual([]);
  });

  it('PDF whose real hash differs from the registered one → FAILED with INVALID_FILE', async () => {
    const ref = await pdfSource(['Some text.'], 'f'.repeat(64));

    await runJob(ref);

    const source = await sourceRow(ref);
    expect(source).toMatchObject({ status: 'FAILED', errorCode: 'INVALID_FILE' });
    expect(source?.errorMessage).toContain("doesn't match");
  });

  it('text that chunks to nothing (headings only) → FAILED with NO_TEXT', async () => {
    const ref = await addSource({
      type: 'TEXT',
      title: 'Empty',
      extractedText: '# Only a heading',
    });

    expect(await runJob(ref)).toEqual({ status: 'stopped', reason: 'failed', code: 'NO_TEXT' });
    expect(await sourceRow(ref)).toMatchObject({ status: 'FAILED', errorCode: 'NO_TEXT' });
  });

  it('a failed reprocess clears nothing: the old error is replaced, old chunks stay', async () => {
    const ref = await websiteSource();
    await runJob(ref);
    scraper.failNext(IngestionError.permanent('PAGE_NOT_FOUND', "This page doesn't exist."));

    await runJob(ref);

    expect(await sourceRow(ref)).toMatchObject({ status: 'FAILED', errorCode: 'PAGE_NOT_FOUND' });
    expect(await chunksOf(ref)).toHaveLength(2);
  });

  it('an unexpected error on the last attempt → FAILED with a generic message', async () => {
    const ref = await websiteSource();
    scraper.failNext(new TypeError('boom'), new TypeError('boom'));
    await service.start(ref);

    await expect(service.extract(ref, RETRY)).rejects.toThrow('boom');
    expect(await service.extract(ref, LAST)).toEqual({
      status: 'stopped',
      reason: 'failed',
      code: 'PROCESSING_FAILED',
    });
    expect(await sourceRow(ref)).toMatchObject({
      status: 'FAILED',
      errorCode: 'PROCESSING_FAILED',
      errorMessage: 'Something went wrong while processing this source. Please try again.',
    });
  });
});

describe('atomic commit', () => {
  const longText = Array.from({ length: 5 }, (_, i) => `## Part ${i}\n\nBody of part ${i}.`).join(
    '\n\n',
  );

  /** Embeddings whose last vector has the wrong size, so the last INSERT of the commit fails. */
  const brokenEmbeddings: EmbeddingsProvider = {
    model: 'broken',
    embed: (texts) =>
      Promise.resolve(texts.map((t, i) => (i === texts.length - 1 ? [1, 2, 3] : fakeVector(t)))),
  };

  it('failure during commit → no chunks written, status unchanged', async () => {
    const ref = await addSource({ type: 'TEXT', title: 'Long', extractedText: longText });
    const broken = createService({ embeddings: brokenEmbeddings });
    await broken.start(ref);
    await broken.extract(ref, RETRY);

    // 5 chunks in batches of 2: two INSERTs succeed before the third fails.
    await expect(broken.embedAndCommit(ref, RETRY)).rejects.toThrow();

    expect(await chunksOf(ref)).toEqual([]);
    expect(await sourceRow(ref)).toMatchObject({
      status: 'PROCESSING',
      chunkCount: 0,
      embeddingModel: null,
      processedAt: null,
    });
  });

  it('failure during a reprocess commit → the old chunks are still there', async () => {
    const ref = await addSource({ type: 'TEXT', title: 'Long', extractedText: longText });
    await runJob(ref);
    const before = await chunksOf(ref);
    expect(before).toHaveLength(5);

    const broken = createService({ embeddings: brokenEmbeddings });
    await broken.start(ref);
    await broken.extract(ref, RETRY);
    await expect(broken.embedAndCommit(ref, RETRY)).rejects.toThrow();

    expect((await chunksOf(ref)).map((c) => c.id)).toEqual(before.map((c) => c.id));
  });

  it('a commit of many chunks stores them all, in order', async () => {
    const ref = await addSource({ type: 'TEXT', title: 'Long', extractedText: longText });

    expect(await runJob(ref)).toEqual({ status: 'ok', chunkCount: 5 });
    expect((await chunksOf(ref)).map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('source deleted mid-processing', () => {
  it('deleted before the job starts → the job stops at step 1', async () => {
    const ref = await textSource();
    await db.delete(sources).where(eq(sources.id, ref.sourceId));

    expect(await runJob(ref)).toEqual({ status: 'stopped', reason: 'not_found' });
    expect(embeddings.calls).toEqual([]);
  });

  it('deleted after extraction → later steps stop, no chunks, no errors', async () => {
    const ref = await textSource();
    await service.start(ref);
    await service.extract(ref, RETRY);
    await db.delete(sources).where(eq(sources.id, ref.sourceId));

    expect(await service.chunk(ref, RETRY)).toEqual({ status: 'stopped', reason: 'not_found' });
    expect(await service.embedAndCommit(ref, RETRY)).toEqual({
      status: 'stopped',
      reason: 'not_found',
    });
    expect(await db.select().from(sourceChunks)).toEqual([]);
  });

  it('deleted while embedding → the commit finds no source and writes nothing', async () => {
    const ref = await textSource();
    const deletingEmbeddings: EmbeddingsProvider = {
      model: 'fake',
      async embed(texts) {
        await db.delete(sources).where(eq(sources.id, ref.sourceId));
        return texts.map((text) => fakeVector(text));
      },
    };
    const run = createService({ embeddings: deletingEmbeddings });
    await run.start(ref);
    await run.extract(ref, RETRY);

    expect(await run.embedAndCommit(ref, RETRY)).toEqual({
      status: 'stopped',
      reason: 'not_found',
    });
    expect(await db.select().from(sourceChunks)).toEqual([]);
  });

  it('a failure after the source is gone is not an error either', async () => {
    const ref = await websiteSource();
    await service.start(ref);
    scraper.failNext(IngestionError.permanent('PAGE_NOT_FOUND', 'Gone.'));
    await db.delete(sources).where(eq(sources.id, ref.sourceId));

    expect(await service.extract(ref, RETRY)).toEqual({ status: 'stopped', reason: 'not_found' });
  });
});

describe('ownership', () => {
  it("a job for another user's source does nothing", async () => {
    const ref = await textSource();
    const [other] = await db.insert(users).values({ clerkUserId: 'user_other' }).returning();
    if (!other) throw new Error('user not created');

    const result = await runJob({ userId: other.id, sourceId: ref.sourceId });

    expect(result).toEqual({ status: 'stopped', reason: 'not_found' });
    expect(await sourceRow(ref)).toMatchObject({ status: 'PENDING' });
  });
});
