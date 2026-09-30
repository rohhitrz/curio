import {
  errorResponseSchema,
  fileUrlResponseSchema,
  notebookDetailSchema,
  notebookSchema,
  sourceListSchema,
  sourceSchema,
  uploadResponseSchema,
} from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { quotas, uploads } from '../../src/config/index.js';
import { sources, users } from '../../src/db/schema/index.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { createFakeStorage, type FakeStorage } from '../fakes/storage.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const PDF_HASH = 'a'.repeat(64);
const VIDEO_ID = 'dQw4w9WgXcQ';

let storage: FakeStorage;
let jobs: FakeJobs;
let app: ReturnType<typeof createTestApp>;

async function createNotebook(auth: string, title = 'Notebook'): Promise<string> {
  const res = await request(app)
    .post('/api/v1/notebooks')
    .set('authorization', auth)
    .send({ title });
  expect(res.status).toBe(201);
  return notebookSchema.parse(res.body).id;
}

function addSource(auth: string, notebookId: string, body: object) {
  return request(app)
    .post(`/api/v1/notebooks/${notebookId}/sources`)
    .set('authorization', auth)
    .send(body);
}

function requestUpload(auth: string, notebookId: string, body: object) {
  return request(app)
    .post(`/api/v1/notebooks/${notebookId}/uploads`)
    .set('authorization', auth)
    .send(body);
}

const pdfUpload = { fileName: 'lecture.pdf', fileSize: 2048, contentType: 'application/pdf' };

/** Upload URL → simulated browser PUT → returns the storage key. */
async function uploadPdf(auth: string, notebookId: string): Promise<string> {
  const res = await requestUpload(auth, notebookId, pdfUpload);
  expect(res.status).toBe(200);
  const { storageKey } = uploadResponseSchema.parse(res.body);
  storage.put(storageKey, pdfUpload.fileSize);
  return storageKey;
}

function errorOf(body: unknown) {
  return errorResponseSchema.parse(body).error;
}

async function userIdOf(clerkUserId: string): Promise<string> {
  const [user] = await getTestDb().select().from(users).where(eq(users.clerkUserId, clerkUserId));
  if (!user) throw new Error(`no user ${clerkUserId}`);
  return user.id;
}

beforeEach(async () => {
  await truncateAllTables();
  storage = createFakeStorage();
  jobs = createFakeJobs();
  app = createTestApp({ storage, jobs });
});

describe('add each source type', () => {
  it('WEBSITE → 202 PENDING, titled by its address', async () => {
    const notebookId = await createNotebook(ALICE);

    const res = await addSource(ALICE, notebookId, {
      type: 'WEBSITE',
      url: 'https://www.example.com/articles/rag/?utm_source=x',
    });

    expect(res.status).toBe(202);
    expect(sourceSchema.parse(res.body)).toMatchObject({
      notebookId,
      type: 'WEBSITE',
      origin: 'USER',
      status: 'PENDING',
      title: 'example.com/articles/rag',
      url: 'https://www.example.com/articles/rag/?utm_source=x',
      chunkCount: 0,
      processedAt: null,
    });
  });

  it('YOUTUBE → 202 PENDING with the canonical URL and video ID', async () => {
    const notebookId = await createNotebook(ALICE);

    const res = await addSource(ALICE, notebookId, {
      type: 'YOUTUBE',
      url: `https://youtu.be/${VIDEO_ID}?t=42`,
    });

    expect(res.status).toBe(202);
    expect(sourceSchema.parse(res.body)).toMatchObject({
      type: 'YOUTUBE',
      status: 'PENDING',
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      metadata: { videoId: VIDEO_ID },
    });
  });

  it('TEXT → 202 PENDING; content is stored but never returned', async () => {
    const notebookId = await createNotebook(ALICE);

    const res = await addSource(ALICE, notebookId, {
      type: 'TEXT',
      title: '  My notes  ',
      content: 'Regularization reduces overfitting.',
    });

    expect(res.status).toBe(202);
    const source = sourceSchema.parse(res.body);
    expect(source).toMatchObject({ type: 'TEXT', status: 'PENDING', title: 'My notes', url: null });
    expect(res.body).not.toHaveProperty('extractedText');
    expect(res.body).not.toHaveProperty('content');

    const [row] = await getTestDb().select().from(sources).where(eq(sources.id, source.id));
    expect(row?.extractedText).toBe('Regularization reduces overfitting.');
  });

  it('PDF → upload URL, browser PUT, register → 202 PENDING under the user prefix', async () => {
    const notebookId = await createNotebook(ALICE);
    const storageKey = await uploadPdf(ALICE, notebookId);

    const res = await addSource(ALICE, notebookId, {
      type: 'PDF',
      title: 'Lecture 3',
      storageKey,
      contentHash: PDF_HASH.toUpperCase(),
    });

    expect(res.status).toBe(202);
    const source = sourceSchema.parse(res.body);
    expect(source).toMatchObject({ type: 'PDF', status: 'PENDING', metadata: { fileSize: 2048 } });
    expect(res.body).not.toHaveProperty('storageKey');

    const aliceId = await userIdOf('user_alice');
    expect(storageKey.startsWith(`users/${aliceId}/uploads/`)).toBe(true);
    const [row] = await getTestDb().select().from(sources).where(eq(sources.id, source.id));
    expect(row).toMatchObject({ userId: aliceId, storageKey, contentHash: PDF_HASH });
  });
});

describe('source/created event', () => {
  it('each source type sends exactly one event with the source and user IDs', async () => {
    const notebookId = await createNotebook(ALICE);
    const storageKey = await uploadPdf(ALICE, notebookId);
    const bodies = [
      { type: 'WEBSITE', url: 'https://example.com/a' },
      { type: 'YOUTUBE', url: `https://youtu.be/${VIDEO_ID}` },
      { type: 'TEXT', title: 'Notes', content: 'Some text.' },
      { type: 'PDF', title: 'Lecture', storageKey, contentHash: PDF_HASH },
    ];

    const sourceIds: string[] = [];
    for (const body of bodies) {
      const res = await addSource(ALICE, notebookId, body);
      expect(res.status).toBe(202);
      sourceIds.push(sourceSchema.parse(res.body).id);
    }

    const userId = await userIdOf('user_alice');
    expect(jobs.sent).toEqual(
      sourceIds.map((sourceId) => ({ name: 'source/created', data: { sourceId, userId } })),
    );
  });

  it('a duplicate → 409 and no second event', async () => {
    const notebookId = await createNotebook(ALICE);
    const body = { type: 'WEBSITE', url: 'https://example.com/a' };
    await addSource(ALICE, notebookId, body);

    const res = await addSource(ALICE, notebookId, body);

    expect(res.status).toBe(409);
    expect(jobs.sent).toHaveLength(1);
  });

  it('a rejected source (validation, not found) sends nothing', async () => {
    const notebookId = await createNotebook(ALICE);

    const invalid = await addSource(ALICE, notebookId, { type: 'YOUTUBE', url: 'https://x.test' });
    const notOwned = await addSource(BOB, notebookId, { type: 'WEBSITE', url: 'https://x.test' });

    expect(invalid.status).toBe(400);
    expect(notOwned.status).toBe(404);
    expect(jobs.sent).toEqual([]);
  });

  it('the job service is down → still 202; the source is saved and stays PENDING', async () => {
    const notebookId = await createNotebook(ALICE);
    jobs.failNextSend(new Error('inngest down'));

    const res = await addSource(ALICE, notebookId, { type: 'WEBSITE', url: 'https://x.test/a' });

    expect(res.status).toBe(202);
    const source = sourceSchema.parse(res.body);
    expect(source.status).toBe('PENDING');
    expect(jobs.sent).toEqual([]);
    const [row] = await getTestDb().select().from(sources).where(eq(sources.id, source.id));
    expect(row?.status).toBe('PENDING');
  });
});

describe('upload URL', () => {
  it('signs a PUT for the declared size with the upload TTL', async () => {
    const notebookId = await createNotebook(ALICE);

    const res = await requestUpload(ALICE, notebookId, pdfUpload);

    expect(res.status).toBe(200);
    const body = uploadResponseSchema.parse(res.body);
    const url = new URL(body.uploadUrl);
    expect(url.searchParams.get('type')).toBe(uploads.pdfContentType);
    expect(url.searchParams.get('length')).toBe(String(pdfUpload.fileSize));
    expect(url.searchParams.get('ttl')).toBe(String(uploads.uploadUrlTtlSeconds));
    const ttlMs = Date.parse(body.expiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan((uploads.uploadUrlTtlSeconds - 30) * 1000);
    expect(ttlMs).toBeLessThanOrEqual(uploads.uploadUrlTtlSeconds * 1000);
  });

  it('file > 25 MB → 400 FILE_TOO_LARGE', async () => {
    const notebookId = await createNotebook(ALICE);

    const res = await requestUpload(ALICE, notebookId, {
      ...pdfUpload,
      fileSize: quotas.pdfMaxBytes + 1,
    });

    expect(res.status).toBe(400);
    expect(errorOf(res.body).code).toBe('FILE_TOO_LARGE');
  });

  it('not a PDF → 400 UNSUPPORTED_FILE_TYPE', async () => {
    const notebookId = await createNotebook(ALICE);

    const res = await requestUpload(ALICE, notebookId, { ...pdfUpload, contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(errorOf(res.body).code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('storage down → 503 SERVICE_UNAVAILABLE', async () => {
    const notebookId = await createNotebook(ALICE);
    storage.failNextCall(new Error('R2 down'));

    const res = await requestUpload(ALICE, notebookId, pdfUpload);

    expect(res.status).toBe(503);
    expect(errorOf(res.body).code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('dedupe', () => {
  it('double submit, same source → exactly one source; second → 409 with existing ID', async () => {
    const notebookId = await createNotebook(ALICE);
    const body = { type: 'WEBSITE', url: 'https://example.com/a' };

    const results = await Promise.all([
      addSource(ALICE, notebookId, body),
      addSource(ALICE, notebookId, body),
    ]);

    const created = results.filter((r) => r.status === 202);
    const conflicts = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const conflict = errorOf(conflicts[0]?.body);
    expect(conflict.code).toBe('DUPLICATE_SOURCE');
    expect(conflict.details).toEqual({
      existingSourceId: sourceSchema.parse(created[0]?.body).id,
    });

    const rows = await getTestDb().select().from(sources).where(eq(sources.notebookId, notebookId));
    expect(rows).toHaveLength(1);
  });

  it('same URL with tracking params → duplicate', async () => {
    const notebookId = await createNotebook(ALICE);
    await addSource(ALICE, notebookId, { type: 'WEBSITE', url: 'https://example.com/post' });

    const res = await addSource(ALICE, notebookId, {
      type: 'WEBSITE',
      url: 'https://WWW.example.com/post/?utm_campaign=news#comments',
    });

    expect(res.status).toBe(409);
    expect(errorOf(res.body).code).toBe('DUPLICATE_SOURCE');
  });

  it('same YouTube video via a different URL form → duplicate', async () => {
    const notebookId = await createNotebook(ALICE);
    await addSource(ALICE, notebookId, {
      type: 'YOUTUBE',
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    });

    const res = await addSource(ALICE, notebookId, {
      type: 'YOUTUBE',
      url: `https://www.youtube.com/shorts/${VIDEO_ID}`,
    });

    expect(res.status).toBe(409);
  });

  it('same text with different line endings → duplicate', async () => {
    const notebookId = await createNotebook(ALICE);
    await addSource(ALICE, notebookId, { type: 'TEXT', title: 'A', content: 'one\ntwo' });

    const res = await addSource(ALICE, notebookId, {
      type: 'TEXT',
      title: 'B',
      content: 'one\r\ntwo\r\n',
    });

    expect(res.status).toBe(409);
  });

  it('same PDF hash → duplicate', async () => {
    const notebookId = await createNotebook(ALICE);
    const first = await uploadPdf(ALICE, notebookId);
    const second = await uploadPdf(ALICE, notebookId);
    const pdf = { type: 'PDF', title: 'Lecture', contentHash: PDF_HASH };
    await addSource(ALICE, notebookId, { ...pdf, storageKey: first });

    const res = await addSource(ALICE, notebookId, { ...pdf, storageKey: second });

    expect(res.status).toBe(409);
  });

  it('the same source in two different notebooks is allowed', async () => {
    const a = await createNotebook(ALICE, 'A');
    const b = await createNotebook(ALICE, 'B');
    const body = { type: 'WEBSITE', url: 'https://example.com/shared' };

    expect((await addSource(ALICE, a, body)).status).toBe(202);
    expect((await addSource(ALICE, b, body)).status).toBe(202);
  });
});

describe('PDF registration', () => {
  const OTHER_HASH = 'b'.repeat(64);

  function registerPdf(notebookId: string, storageKey: string, contentHash: string) {
    return addSource(ALICE, notebookId, { type: 'PDF', title: 'Lecture', storageKey, contentHash });
  }

  it('the same upload registered twice in one notebook → second is 400 UPLOAD_NOT_FOUND', async () => {
    const notebookId = await createNotebook(ALICE);
    const storageKey = await uploadPdf(ALICE, notebookId);
    expect((await registerPdf(notebookId, storageKey, PDF_HASH)).status).toBe(202);

    const res = await registerPdf(notebookId, storageKey, OTHER_HASH);

    expect(res.status).toBe(400);
    expect(errorOf(res.body)).toMatchObject({
      code: 'UPLOAD_NOT_FOUND',
      message: 'This upload was already added as a source. Please upload the file again.',
    });
  });

  it('the same upload registered in another notebook → 400 UPLOAD_NOT_FOUND', async () => {
    const a = await createNotebook(ALICE, 'A');
    const b = await createNotebook(ALICE, 'B');
    const storageKey = await uploadPdf(ALICE, a);
    expect((await registerPdf(a, storageKey, PDF_HASH)).status).toBe(202);

    const res = await registerPdf(b, storageKey, PDF_HASH);

    expect(res.status).toBe(400);
    expect(errorOf(res.body).code).toBe('UPLOAD_NOT_FOUND');
  });

  it('parallel registrations of one upload in two notebooks → exactly one source', async () => {
    const a = await createNotebook(ALICE, 'A');
    const b = await createNotebook(ALICE, 'B');
    const storageKey = await uploadPdf(ALICE, a);

    const results = await Promise.all([
      registerPdf(a, storageKey, PDF_HASH),
      registerPdf(b, storageKey, PDF_HASH),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([202, 400]);
    const rows = await getTestDb().select().from(sources).where(eq(sources.storageKey, storageKey));
    expect(rows).toHaveLength(1);
  });

  it("another user's storageKey → 400 UPLOAD_NOT_FOUND", async () => {
    const bobNotebook = await createNotebook(BOB);
    const bobKey = await uploadPdf(BOB, bobNotebook);
    const aliceNotebook = await createNotebook(ALICE);

    const res = await addSource(ALICE, aliceNotebook, {
      type: 'PDF',
      title: 'Stolen',
      storageKey: bobKey,
      contentHash: PDF_HASH,
    });

    expect(res.status).toBe(400);
    expect(errorOf(res.body).code).toBe('UPLOAD_NOT_FOUND');
  });

  it("file isn't in R2 → 400 UPLOAD_NOT_FOUND", async () => {
    const notebookId = await createNotebook(ALICE);
    const res0 = await requestUpload(ALICE, notebookId, pdfUpload);
    const { storageKey } = uploadResponseSchema.parse(res0.body);

    const res = await addSource(ALICE, notebookId, {
      type: 'PDF',
      title: 'Never uploaded',
      storageKey,
      contentHash: PDF_HASH,
    });

    expect(res.status).toBe(400);
    expect(errorOf(res.body).code).toBe('UPLOAD_NOT_FOUND');
  });

  it('path tricks in the storageKey → 400 UPLOAD_NOT_FOUND', async () => {
    const notebookId = await createNotebook(ALICE);
    const own = await uploadPdf(ALICE, notebookId);

    const res = await addSource(ALICE, notebookId, {
      type: 'PDF',
      title: 'Tricky',
      storageKey: own.replace('/uploads/', '/uploads/../../other/'),
      contentHash: PDF_HASH,
    });

    expect(res.status).toBe(400);
    expect(errorOf(res.body).code).toBe('UPLOAD_NOT_FOUND');
  });

  it('storage down while checking the file → 503', async () => {
    const notebookId = await createNotebook(ALICE);
    const storageKey = await uploadPdf(ALICE, notebookId);
    storage.failNextCall(new Error('R2 down'));

    const res = await addSource(ALICE, notebookId, {
      type: 'PDF',
      title: 'Lecture',
      storageKey,
      contentHash: PDF_HASH,
    });

    expect(res.status).toBe(503);
  });
});

describe('quotas', () => {
  async function fillNotebook(notebookId: string) {
    const userId = await userIdOf('user_alice');
    await getTestDb()
      .insert(sources)
      .values(
        Array.from({ length: quotas.sourcesPerNotebook }, (_, i) => ({
          notebookId,
          userId,
          type: 'TEXT' as const,
          title: `Note ${i}`,
          contentHash: `hash-${i}`,
        })),
      );
  }

  it('51st source in a notebook → 400 QUOTA_EXCEEDED', async () => {
    const notebookId = await createNotebook(ALICE);
    await fillNotebook(notebookId);

    const res = await addSource(ALICE, notebookId, {
      type: 'WEBSITE',
      url: 'https://example.com/51',
    });

    expect(res.status).toBe(400);
    expect(errorOf(res.body).code).toBe('QUOTA_EXCEEDED');
  });

  it('upload URL for a full notebook → 400 QUOTA_EXCEEDED', async () => {
    const notebookId = await createNotebook(ALICE);
    await fillNotebook(notebookId);

    const res = await requestUpload(ALICE, notebookId, pdfUpload);

    expect(res.status).toBe(400);
    expect(errorOf(res.body).code).toBe('QUOTA_EXCEEDED');
  });

  it('parallel adds to a nearly full notebook never exceed the quota', async () => {
    const notebookId = await createNotebook(ALICE);
    await fillNotebook(notebookId);
    await getTestDb().delete(sources).where(eq(sources.contentHash, 'hash-0'));

    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        addSource(ALICE, notebookId, { type: 'WEBSITE', url: `https://example.com/p${i}` }),
      ),
    );

    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    const rows = await getTestDb().select().from(sources).where(eq(sources.notebookId, notebookId));
    expect(rows).toHaveLength(quotas.sourcesPerNotebook);
  });

  it('text at the limit is accepted; one char over → 400 QUOTA_EXCEEDED', async () => {
    const notebookId = await createNotebook(ALICE);
    // Multi-byte chars: 100k of them is ~300 KB of JSON, above Express's 100 KB default.
    const atLimit = 'é'.repeat(quotas.textMaxChars - 1) + 'a';

    const ok = await addSource(ALICE, notebookId, {
      type: 'TEXT',
      title: 'Long',
      content: atLimit,
    });
    const over = await addSource(ALICE, notebookId, {
      type: 'TEXT',
      title: 'Too long',
      content: `${atLimit}b`,
    });

    expect(ok.status).toBe(202);
    expect(over.status).toBe(400);
    expect(errorOf(over.body).code).toBe('QUOTA_EXCEEDED');
  });
});

describe('validation', () => {
  it.each([
    ['unknown type', { type: 'AUDIO', url: 'https://example.com' }],
    ['missing url', { type: 'WEBSITE' }],
    ['non-http url', { type: 'WEBSITE', url: 'javascript:alert(1)' }],
    ['extra field', { type: 'WEBSITE', url: 'https://example.com', title: 'x' }],
    ['empty text', { type: 'TEXT', title: 'Empty', content: '   ' }],
    ['bad PDF hash', { type: 'PDF', title: 'x', storageKey: 'k', contentHash: 'abc' }],
    ['not a YouTube video', { type: 'YOUTUBE', url: 'https://example.com/watch?v=dQw4w9WgXcQ' }],
  ])('%s → 400 VALIDATION_ERROR', async (_label, body) => {
    const notebookId = await createNotebook(ALICE);

    const res = await addSource(ALICE, notebookId, body);

    expect(res.status).toBe(400);
    expect(errorOf(res.body).code).toBe('VALIDATION_ERROR');
  });

  it('invalid YouTube URL names the url field', async () => {
    const notebookId = await createNotebook(ALICE);

    const res = await addSource(ALICE, notebookId, {
      type: 'YOUTUBE',
      url: 'https://www.youtube.com/@channel',
    });

    expect(errorOf(res.body).details).toEqual({ url: 'Must be a YouTube video URL' });
  });
});

describe('ownership', () => {
  it.each([
    ['add source', (id: string) => addSource(ALICE, id, { type: 'WEBSITE', url: 'https://x.dev' })],
    ['upload URL', (id: string) => requestUpload(ALICE, id, pdfUpload)],
  ])("%s in another user's notebook → 404", async (_label, call) => {
    const bobNotebook = await createNotebook(BOB);

    const res = await call(bobNotebook);

    expect(res.status).toBe(404);
    expect(errorOf(res.body).code).toBe('NOT_FOUND');
  });

  it("PDF with Alice's own key into Bob's notebook → 404, not UPLOAD_NOT_FOUND", async () => {
    const aliceNotebook = await createNotebook(ALICE);
    const storageKey = await uploadPdf(ALICE, aliceNotebook);
    const bobNotebook = await createNotebook(BOB);

    const res = await addSource(ALICE, bobNotebook, {
      type: 'PDF',
      title: 'x',
      storageKey,
      contentHash: PDF_HASH,
    });

    expect(res.status).toBe(404);
  });

  it('malformed notebook ID → 404', async () => {
    const res = await addSource(ALICE, 'not-a-uuid', { type: 'WEBSITE', url: 'https://x.dev' });

    expect(res.status).toBe(404);
  });

  it('no token → 401', async () => {
    const res = await request(app)
      .post(`/api/v1/notebooks/${crypto.randomUUID()}/sources`)
      .send({ type: 'WEBSITE', url: 'https://x.dev' });

    expect(res.status).toBe(401);
  });
});

describe('list, get, rename', () => {
  it('list → all sources oldest first, without internal fields', async () => {
    const notebookId = await createNotebook(ALICE);
    await addSource(ALICE, notebookId, { type: 'WEBSITE', url: 'https://example.com/1' });
    await addSource(ALICE, notebookId, { type: 'TEXT', title: 'Notes', content: 'secret text' });

    const res = await request(app)
      .get(`/api/v1/notebooks/${notebookId}/sources`)
      .set('authorization', ALICE);

    expect(res.status).toBe(200);
    const list = sourceListSchema.parse(res.body);
    expect(list.items.map((s) => s.type)).toEqual(['WEBSITE', 'TEXT']);
    expect(list.nextCursor).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('secret text');
  });

  it('list of an empty notebook → empty items', async () => {
    const notebookId = await createNotebook(ALICE);

    const res = await request(app)
      .get(`/api/v1/notebooks/${notebookId}/sources`)
      .set('authorization', ALICE);

    expect(sourceListSchema.parse(res.body).items).toEqual([]);
  });

  it('get → the source; PDF responses never include the storage key', async () => {
    const notebookId = await createNotebook(ALICE);
    const storageKey = await uploadPdf(ALICE, notebookId);
    const created = await addSource(ALICE, notebookId, {
      type: 'PDF',
      title: 'Lecture',
      storageKey,
      contentHash: PDF_HASH,
    });
    const { id } = sourceSchema.parse(created.body);

    const res = await request(app).get(`/api/v1/sources/${id}`).set('authorization', ALICE);

    expect(res.status).toBe(200);
    expect(sourceSchema.parse(res.body)).toEqual(sourceSchema.parse(created.body));
    expect(JSON.stringify(res.body)).not.toContain(storageKey);
  });

  it('rename → 200 with the trimmed title; empty title → 400', async () => {
    const notebookId = await createNotebook(ALICE);
    const created = await addSource(ALICE, notebookId, { type: 'WEBSITE', url: 'https://x.dev' });
    const { id } = sourceSchema.parse(created.body);

    const ok = await request(app)
      .patch(`/api/v1/sources/${id}`)
      .set('authorization', ALICE)
      .send({ title: '  Better title  ' });
    const bad = await request(app)
      .patch(`/api/v1/sources/${id}`)
      .set('authorization', ALICE)
      .send({ title: '  ' });
    const extra = await request(app)
      .patch(`/api/v1/sources/${id}`)
      .set('authorization', ALICE)
      .send({ title: 'x', status: 'READY' });

    expect(ok.status).toBe(200);
    expect(sourceSchema.parse(ok.body).title).toBe('Better title');
    expect(bad.status).toBe(400);
    expect(extra.status).toBe(400);
  });

  it('notebook detail counts its sources', async () => {
    const notebookId = await createNotebook(ALICE);
    await addSource(ALICE, notebookId, { type: 'WEBSITE', url: 'https://example.com/1' });
    await addSource(ALICE, notebookId, { type: 'WEBSITE', url: 'https://example.com/2' });

    const res = await request(app)
      .get(`/api/v1/notebooks/${notebookId}`)
      .set('authorization', ALICE);

    expect(notebookDetailSchema.parse(res.body).sourceCount).toBe(2);
  });
});

describe('delete', () => {
  async function addPdf(auth: string) {
    const notebookId = await createNotebook(auth);
    const storageKey = await uploadPdf(auth, notebookId);
    const res = await addSource(auth, notebookId, {
      type: 'PDF',
      title: 'Lecture',
      storageKey,
      contentHash: PDF_HASH,
    });
    return { id: sourceSchema.parse(res.body).id, storageKey, notebookId };
  }

  it('delete source → 204, row gone, R2 delete called', async () => {
    const { id, storageKey } = await addPdf(ALICE);

    const res = await request(app).delete(`/api/v1/sources/${id}`).set('authorization', ALICE);

    expect(res.status).toBe(204);
    expect(await getTestDb().select().from(sources).where(eq(sources.id, id))).toEqual([]);
    expect(storage.deleted).toEqual([storageKey]);
    expect(storage.has(storageKey)).toBe(false);
  });

  it('deleting a non-PDF source never calls R2', async () => {
    const notebookId = await createNotebook(ALICE);
    const created = await addSource(ALICE, notebookId, { type: 'WEBSITE', url: 'https://x.dev' });

    const res = await request(app)
      .delete(`/api/v1/sources/${sourceSchema.parse(created.body).id}`)
      .set('authorization', ALICE);

    expect(res.status).toBe(204);
    expect(storage.deleted).toEqual([]);
  });

  it('R2 delete fails → still 204 and the row is gone (orphan logged)', async () => {
    const { id } = await addPdf(ALICE);
    storage.failNextCall(new Error('R2 down'));

    const res = await request(app).delete(`/api/v1/sources/${id}`).set('authorization', ALICE);

    expect(res.status).toBe(204);
    expect(await getTestDb().select().from(sources).where(eq(sources.id, id))).toEqual([]);
  });

  it('deleted source can be added again', async () => {
    const notebookId = await createNotebook(ALICE);
    const body = { type: 'WEBSITE', url: 'https://example.com/again' };
    const first = await addSource(ALICE, notebookId, body);
    await request(app)
      .delete(`/api/v1/sources/${sourceSchema.parse(first.body).id}`)
      .set('authorization', ALICE);

    expect((await addSource(ALICE, notebookId, body)).status).toBe(202);
  });

  it('delete twice → second is 404', async () => {
    const { id } = await addPdf(ALICE);
    await request(app).delete(`/api/v1/sources/${id}`).set('authorization', ALICE);

    const res = await request(app).delete(`/api/v1/sources/${id}`).set('authorization', ALICE);

    expect(res.status).toBe(404);
  });
});

describe('file-url', () => {
  it('PDF → signed GET URL with the download TTL', async () => {
    const notebookId = await createNotebook(ALICE);
    const storageKey = await uploadPdf(ALICE, notebookId);
    const created = await addSource(ALICE, notebookId, {
      type: 'PDF',
      title: 'Lecture',
      storageKey,
      contentHash: PDF_HASH,
    });

    const res = await request(app)
      .get(`/api/v1/sources/${sourceSchema.parse(created.body).id}/file-url`)
      .set('authorization', ALICE);

    expect(res.status).toBe(200);
    const body = fileUrlResponseSchema.parse(res.body);
    const url = new URL(body.url);
    expect(url.pathname).toBe(`/${storageKey}`);
    expect(url.searchParams.get('ttl')).toBe(String(uploads.downloadUrlTtlSeconds));
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(
      uploads.downloadUrlTtlSeconds * 1000,
    );
  });

  it('non-PDF source → 404', async () => {
    const notebookId = await createNotebook(ALICE);
    const created = await addSource(ALICE, notebookId, { type: 'WEBSITE', url: 'https://x.dev' });

    const res = await request(app)
      .get(`/api/v1/sources/${sourceSchema.parse(created.body).id}/file-url`)
      .set('authorization', ALICE);

    expect(res.status).toBe(404);
  });
});

describe("another user's source", () => {
  it('get, patch, delete, file-url, content, chunks, reprocess, list → 404, and nothing changes', async () => {
    const notebookId = await createNotebook(BOB);
    const storageKey = await uploadPdf(BOB, notebookId);
    const created = await addSource(BOB, notebookId, {
      type: 'PDF',
      title: "Bob's",
      storageKey,
      contentHash: PDF_HASH,
    });
    const { id } = sourceSchema.parse(created.body);

    const calls = [
      request(app).get(`/api/v1/sources/${id}`).set('authorization', ALICE),
      request(app).patch(`/api/v1/sources/${id}`).set('authorization', ALICE).send({ title: 'x' }),
      request(app).delete(`/api/v1/sources/${id}`).set('authorization', ALICE),
      request(app).get(`/api/v1/sources/${id}/file-url`).set('authorization', ALICE),
      request(app).get(`/api/v1/sources/${id}/content`).set('authorization', ALICE),
      request(app).get(`/api/v1/sources/${id}/chunks`).set('authorization', ALICE),
      request(app).post(`/api/v1/sources/${id}/reprocess`).set('authorization', ALICE),
      request(app).get(`/api/v1/notebooks/${notebookId}/sources`).set('authorization', ALICE),
    ];

    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(404);
      expect(errorOf(res.body).code).toBe('NOT_FOUND');
    }
    const [row] = await getTestDb().select().from(sources).where(eq(sources.id, id));
    expect(row?.title).toBe("Bob's");
    expect(row?.status).toBe('PENDING');
    expect(storage.deleted).toEqual([]);
    // Only Bob's own add sent an event.
    expect(jobs.sent).toHaveLength(1);
  });

  it('malformed source ID → 404', async () => {
    const res = await request(app).get('/api/v1/sources/not-a-uuid').set('authorization', ALICE);

    expect(res.status).toBe(404);
  });
});
