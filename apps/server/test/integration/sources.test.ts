import {
  errorResponseSchema,
  notebookSchema,
  sourceSchema,
  uploadResponseSchema,
} from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { quotas, uploads } from '../../src/config/index.js';
import { sources, users } from '../../src/db/schema/index.js';
import { createFakeStorage, type FakeStorage } from '../fakes/storage.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const PDF_HASH = 'a'.repeat(64);
const VIDEO_ID = 'dQw4w9WgXcQ';

let storage: FakeStorage;
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
  app = createTestApp(storage);
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
