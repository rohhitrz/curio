import {
  errorResponseSchema,
  notebookSchema,
  sourceChunkListSchema,
  sourceContentSchema,
  sourceSchema,
} from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { sourceChunks, sources } from '../../src/db/schema/index.js';
import { fakeVector } from '../fakes/embeddings.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const db = getTestDb();

let jobs: FakeJobs;
let app: ReturnType<typeof createTestApp>;
let notebookId: string;

/** A text source as it is right after being added (`PENDING`). */
async function addTextSource(content = 'Some notes.'): Promise<string> {
  const res = await request(app)
    .post(`/api/v1/notebooks/${notebookId}/sources`)
    .set('authorization', ALICE)
    .send({ type: 'TEXT', title: 'Notes', content });
  expect(res.status).toBe(202);
  return sourceSchema.parse(res.body).id;
}

function setStatus(sourceId: string, values: Partial<typeof sources.$inferInsert>) {
  return db.update(sources).set(values).where(eq(sources.id, sourceId));
}

async function addChunks(sourceId: string, count: number) {
  await db.insert(sourceChunks).values(
    Array.from({ length: count }, (_, index) => ({
      sourceId,
      notebookId,
      chunkIndex: index,
      content: `Chunk ${index}`,
      contextHeader: 'Notes',
      embedding: fakeVector(`chunk ${index}`),
      tokenCount: 2,
      headingPath: index === 0 ? null : 'Part',
      charStart: index * 10,
      charEnd: index * 10 + 7,
    })),
  );
}

const get = (path: string) => request(app).get(`/api/v1${path}`).set('authorization', ALICE);
const reprocess = (sourceId: string) =>
  request(app).post(`/api/v1/sources/${sourceId}/reprocess`).set('authorization', ALICE);
const errorCode = (body: unknown) => errorResponseSchema.parse(body).error.code;

beforeEach(async () => {
  await truncateAllTables();
  jobs = createFakeJobs();
  app = createTestApp({ jobs });
  const res = await request(app)
    .post('/api/v1/notebooks')
    .set('authorization', ALICE)
    .send({ title: 'ML' });
  notebookId = notebookSchema.parse(res.body).id;
});

describe('reprocess', () => {
  it('READY source → 202, back to PENDING, a source/reprocess event is sent', async () => {
    const sourceId = await addTextSource();
    await setStatus(sourceId, { status: 'READY', chunkCount: 3 });
    const userId = jobs.sent[0]?.data.userId;

    const res = await reprocess(sourceId);

    expect(res.status).toBe(202);
    expect(sourceSchema.parse(res.body)).toMatchObject({ id: sourceId, status: 'PENDING' });
    expect(jobs.sent.at(-1)).toEqual({ name: 'source/reprocess', data: { sourceId, userId } });
  });

  it('FAILED source → 202 and the old failure reason is cleared', async () => {
    const sourceId = await addTextSource();
    await setStatus(sourceId, {
      status: 'FAILED',
      errorCode: 'PAGE_NOT_FOUND',
      errorMessage: "This page doesn't exist.",
    });

    const res = await reprocess(sourceId);

    expect(res.status).toBe(202);
    expect(sourceSchema.parse(res.body)).toMatchObject({
      status: 'PENDING',
      errorCode: null,
      errorMessage: null,
    });
  });

  it('keeps the old chunks until the new ones are committed', async () => {
    const sourceId = await addTextSource();
    await setStatus(sourceId, { status: 'READY' });
    await addChunks(sourceId, 2);

    await reprocess(sourceId);

    expect(await db.select().from(sourceChunks)).toHaveLength(2);
  });

  it.each(['PENDING', 'PROCESSING'] as const)(
    '%s source → 409 ALREADY_PROCESSING, no event',
    async (status) => {
      const sourceId = await addTextSource();
      await setStatus(sourceId, { status });

      const res = await reprocess(sourceId);

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('ALREADY_PROCESSING');
      expect(jobs.sent).toHaveLength(1); // only the source/created from adding it
    },
  );

  it('double click → one 202, one 409, one event', async () => {
    const sourceId = await addTextSource();
    await setStatus(sourceId, { status: 'READY' });

    const results = await Promise.all([reprocess(sourceId), reprocess(sourceId)]);

    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(jobs.sent.filter((e) => e.name === 'source/reprocess')).toHaveLength(1);
  });

  it('the job service is down → still 202; the source stays PENDING for the sweeper', async () => {
    const sourceId = await addTextSource();
    await setStatus(sourceId, { status: 'READY' });
    jobs.failNextSend(new Error('inngest down'));

    const res = await reprocess(sourceId);

    expect(res.status).toBe(202);
    const [row] = await db.select().from(sources).where(eq(sources.id, sourceId));
    expect(row?.status).toBe('PENDING');
  });

  it('unknown or malformed source ID → 404', async () => {
    expect((await reprocess(crypto.randomUUID())).status).toBe(404);
    expect((await reprocess('not-a-uuid')).status).toBe(404);
  });
});

describe('content', () => {
  it('returns the extracted text', async () => {
    const sourceId = await addTextSource('# Notes\n\nGradient descent.');

    const res = await get(`/sources/${sourceId}/content`);

    expect(res.status).toBe(200);
    expect(sourceContentSchema.parse(res.body)).toEqual({
      content: '# Notes\n\nGradient descent.',
    });
  });

  it('a source that has not been read yet → content null', async () => {
    const res = await request(app)
      .post(`/api/v1/notebooks/${notebookId}/sources`)
      .set('authorization', ALICE)
      .send({ type: 'WEBSITE', url: 'https://example.com/a' });
    const { id } = sourceSchema.parse(res.body);

    const content = await get(`/sources/${id}/content`);

    expect(content.status).toBe(200);
    expect(sourceContentSchema.parse(content.body)).toEqual({ content: null });
  });

  it('unknown source → 404', async () => {
    expect((await get(`/sources/${crypto.randomUUID()}/content`)).status).toBe(404);
  });
});

describe('chunks', () => {
  it('returns chunks in document order with their locations, never the embedding', async () => {
    const sourceId = await addTextSource();
    await addChunks(sourceId, 3);

    const res = await get(`/sources/${sourceId}/chunks`);

    expect(res.status).toBe(200);
    const page = sourceChunkListSchema.parse(res.body);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(page.items[1]).toMatchObject({
      content: 'Chunk 1',
      contextHeader: 'Notes',
      tokenCount: 2,
      headingPath: 'Part',
      pageNumber: null,
      startSeconds: null,
      endSeconds: null,
      charStart: 10,
      charEnd: 17,
    });
    const [raw] = (res.body as { items: object[] }).items;
    expect(raw).not.toHaveProperty('embedding');
    expect(raw).not.toHaveProperty('searchVector');
  });

  it('pages through with the cursor: no duplicates, no gaps', async () => {
    const sourceId = await addTextSource();
    await addChunks(sourceId, 5);

    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? 'limit=2' : `limit=2&cursor=${cursor}`;
      const res = await get(`/sources/${sourceId}/chunks?${query}`);
      const page = sourceChunkListSchema.parse(res.body);
      seen.push(...page.items.map((c) => c.chunkIndex));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null);

    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(pages).toBe(3);
  });

  it('a source with no chunks yet → empty page', async () => {
    const sourceId = await addTextSource();

    const res = await get(`/sources/${sourceId}/chunks`);

    expect(sourceChunkListSchema.parse(res.body)).toEqual({ items: [], nextCursor: null });
  });

  it('tampered cursor or a limit above the max → 400', async () => {
    const sourceId = await addTextSource();

    const tampered = await get(`/sources/${sourceId}/chunks?cursor=not-a-cursor`);
    const tooMany = await get(`/sources/${sourceId}/chunks?limit=1000`);

    expect(tampered.status).toBe(400);
    expect(errorCode(tampered.body)).toBe('VALIDATION_ERROR');
    expect(tooMany.status).toBe(400);
  });

  it('unknown source → 404', async () => {
    expect((await get(`/sources/${crypto.randomUUID()}/chunks`)).status).toBe(404);
  });
});
