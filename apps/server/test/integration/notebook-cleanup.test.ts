import { InngestTestEngine } from '@inngest/test';
import { notebookSchema, uploadResponseSchema } from '@curio/shared';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { notebooks, sourceChunks, sources, users } from '../../src/db/schema/index.js';
import { createCleanupNotebookFilesFunction } from '../../src/inngest/cleanup-notebook-files.js';
import { createInngestClient } from '../../src/lib/jobs/index.js';
import { createNotebooksRepository } from '../../src/repositories/notebooks.repository.js';
import { createTopicsRepository } from '../../src/repositories/topics.repository.js';
import { createNotebooksService } from '../../src/services/notebooks.service.js';
import { createTopicsService } from '../../src/services/topics.service.js';
import { createFakeEmbeddings } from '../fakes/embeddings.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { createFakeStorage, type FakeStorage } from '../fakes/storage.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const db = getTestDb();
const logger = pino({ level: 'silent' });

/** The cleanup job never touches topics; the service just needs one. */
const topicsService = () =>
  createTopicsService({
    repository: createTopicsRepository(db),
    embeddings: createFakeEmbeddings().provider,
    logger,
  });

let storage: FakeStorage;
let jobs: FakeJobs;
let app: ReturnType<typeof createTestApp>;

async function createNotebook(auth = ALICE): Promise<string> {
  const res = await request(app).post('/api/v1/notebooks').set('authorization', auth).send({
    title: 'Notebook',
  });
  return notebookSchema.parse(res.body).id;
}

/** Uploads a PDF and registers it as a source. Returns its R2 key. */
async function addPdf(notebookId: string, hash: string): Promise<string> {
  const upload = await request(app)
    .post(`/api/v1/notebooks/${notebookId}/uploads`)
    .set('authorization', ALICE)
    .send({ fileName: 'a.pdf', fileSize: 2048, contentType: 'application/pdf' });
  const { storageKey } = uploadResponseSchema.parse(upload.body);
  storage.put(storageKey, 2048);
  const res = await request(app)
    .post(`/api/v1/notebooks/${notebookId}/sources`)
    .set('authorization', ALICE)
    .send({ type: 'PDF', title: 'File', storageKey, contentHash: hash.repeat(64) });
  expect(res.status).toBe(202);
  return storageKey;
}

const deleteNotebook = (notebookId: string, auth = ALICE) =>
  request(app).delete(`/api/v1/notebooks/${notebookId}`).set('authorization', auth);

const cleanupEvents = () => jobs.sent.filter((event) => event.name === 'notebook/deleted');

async function userIdOf(clerkUserId: string): Promise<string> {
  const [user] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
  if (!user) throw new Error(`no user ${clerkUserId}`);
  return user.id;
}

beforeEach(async () => {
  await truncateAllTables();
  storage = createFakeStorage();
  jobs = createFakeJobs();
  app = createTestApp({ storage, jobs });
});

describe('delete notebook', () => {
  it('the cleanup job receives all R2 keys; rows are gone at once, files are not deleted inline', async () => {
    const notebookId = await createNotebook();
    const keyA = await addPdf(notebookId, 'a');
    const keyB = await addPdf(notebookId, 'b');
    await request(app)
      .post(`/api/v1/notebooks/${notebookId}/sources`)
      .set('authorization', ALICE)
      .send({ type: 'TEXT', title: 'Notes', content: 'Text has no file.' });

    const res = await deleteNotebook(notebookId);

    expect(res.status).toBe(204);
    const [event] = cleanupEvents();
    expect(cleanupEvents()).toHaveLength(1);
    expect(event?.data).toMatchObject({ notebookId, userId: await userIdOf('user_alice') });
    expect([...(event?.data as { storageKeys: string[] }).storageKeys].sort()).toEqual(
      [keyA, keyB].sort(),
    );
    expect(await db.select().from(notebooks)).toEqual([]);
    expect(await db.select().from(sources)).toEqual([]);
    expect(await db.select().from(sourceChunks)).toEqual([]);
    expect(storage.deleted).toEqual([]);
  });

  it('a notebook without uploaded files sends no cleanup event', async () => {
    const notebookId = await createNotebook();
    await request(app)
      .post(`/api/v1/notebooks/${notebookId}/sources`)
      .set('authorization', ALICE)
      .send({ type: 'WEBSITE', url: 'https://example.com/a' });

    expect((await deleteNotebook(notebookId)).status).toBe(204);
    expect(cleanupEvents()).toEqual([]);
  });

  it('only the deleted notebook’s keys are sent', async () => {
    const kept = await createNotebook();
    const keptKey = await addPdf(kept, 'a');
    const removed = await createNotebook();
    const removedKey = await addPdf(removed, 'b');

    await deleteNotebook(removed);

    expect(cleanupEvents()[0]?.data).toMatchObject({ storageKeys: [removedKey] });
    const [left] = await db.select().from(sources);
    expect(left?.storageKey).toBe(keptKey);
  });

  it('the job service is down → still 204 and the notebook is gone', async () => {
    const notebookId = await createNotebook();
    await addPdf(notebookId, 'a');
    jobs.failNextSend(new Error('inngest down'));

    expect((await deleteNotebook(notebookId)).status).toBe(204);
    expect(await db.select().from(notebooks)).toEqual([]);
  });

  it("another user's notebook → 404, nothing deleted, no event", async () => {
    const notebookId = await createNotebook();
    await addPdf(notebookId, 'a');

    expect((await deleteNotebook(notebookId, BOB)).status).toBe(404);
    expect(await db.select().from(notebooks)).toHaveLength(1);
    expect(cleanupEvents()).toEqual([]);
  });
});

describe('cleanupNotebookFiles function', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const keys = [
    `users/${userId}/uploads/${crypto.randomUUID()}.pdf`,
    `users/${userId}/uploads/${crypto.randomUUID()}.pdf`,
  ];

  function engine() {
    const service = createNotebooksService(
      createNotebooksRepository(db),
      storage.provider,
      jobs.provider,
      logger,
      topicsService(),
    );
    const client = createInngestClient({
      isDev: true,
      logger,
      fetch: () => Promise.reject(new Error('network is blocked in tests')),
    });
    return new InngestTestEngine({ function: createCleanupNotebookFilesFunction(client, service) });
  }

  const run = (storageKeys: string[]) =>
    engine().execute({
      events: [
        {
          name: 'notebook/deleted',
          data: { notebookId: crypto.randomUUID(), userId, storageKeys },
        },
      ],
    });

  it('deletes every file named in the event', async () => {
    for (const key of keys) storage.put(key);

    const { result, error } = await run(keys);

    expect(error).toBeUndefined();
    expect(result).toEqual({ deleted: 2 });
    expect([...storage.deleted].sort()).toEqual([...keys].sort());
    expect(keys.some((key) => storage.has(key))).toBe(false);
  });

  it('running it again is harmless (files already gone)', async () => {
    await run(keys);

    const { result, error } = await run(keys);

    expect(error).toBeUndefined();
    expect(result).toEqual({ deleted: 2 });
  });

  it('never deletes a key outside the user’s own upload folder', async () => {
    const foreign = `users/22222222-2222-4222-8222-222222222222/uploads/${crypto.randomUUID()}.pdf`;
    storage.put(foreign);

    const { result } = await run([keys[0] ?? '', foreign, '../../etc/passwd']);

    expect(result).toEqual({ deleted: 1 });
    expect(storage.deleted).toEqual([keys[0]]);
    expect(storage.has(foreign)).toBe(true);
  });

  it('storage failure → the step throws, so the job retries', async () => {
    storage.failNextCall(new Error('R2 down'));

    const { error } = await run(keys);

    expect(error).toMatchObject({ message: '1 of 2 files could not be deleted' });
  });

  it('listens for notebook/deleted', () => {
    const service = createNotebooksService(
      createNotebooksRepository(db),
      storage.provider,
      jobs.provider,
      logger,
      topicsService(),
    );
    const fn = createCleanupNotebookFilesFunction(
      createInngestClient({ isDev: true, logger }),
      service,
    );

    expect(fn.opts).toMatchObject({
      id: 'cleanup-notebook-files',
      triggers: [{ event: 'notebook/deleted' }],
    });
  });
});
