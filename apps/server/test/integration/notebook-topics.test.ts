import { errorResponseSchema, notebookDetailSchema, notebookSchema } from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { notebooks, topics } from '../../src/db/schema/index.js';
import { IngestionError } from '../../src/errors/ingestion-error.js';
import { createFakeEmbeddings, fakeVector, type FakeEmbeddings } from '../fakes/embeddings.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const db = getTestDb();

let embeddings: FakeEmbeddings;
let app: ReturnType<typeof createTestApp>;

beforeEach(async () => {
  await truncateAllTables();
  embeddings = createFakeEmbeddings();
  app = createTestApp({ embeddings });
});

async function createNotebook(auth = ALICE): Promise<string> {
  const res = await request(app)
    .post('/api/v1/notebooks')
    .set('authorization', auth)
    .send({ title: 'Notes' });
  return notebookSchema.parse(res.body).id;
}

const patch = (notebookId: string, body: object, auth = ALICE) =>
  request(app).patch(`/api/v1/notebooks/${notebookId}`).set('authorization', auth).send(body);

const topicRows = () => db.select().from(topics);

describe('PATCH /notebooks topic', () => {
  it('a new topic is created once, embedded from its name, and shown on the notebook', async () => {
    const notebookId = await createNotebook();

    const res = await patch(notebookId, { topic: ' Machine Learning ' });

    expect(res.status).toBe(200);
    const notebook = notebookSchema.parse(res.body);
    expect(notebook.topic?.name).toBe('Machine Learning');
    const rows = await topicRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.normalizedName).toBe('machine learning');
    // pgvector stores float32, so compare within its precision.
    const expected = fakeVector('Machine Learning');
    expect(rows[0]?.embedding).toHaveLength(expected.length);
    expect(rows[0]?.embedding.every((v, i) => Math.abs(v - (expected[i] ?? 0)) < 1e-6)).toBe(true);
    expect(embeddings.calls).toEqual([['Machine Learning']]);

    const detail = await request(app)
      .get(`/api/v1/notebooks/${notebookId}`)
      .set('authorization', ALICE);
    expect(notebookDetailSchema.parse(detail.body).topic).toEqual(notebook.topic);
  });

  it('another wording of the same topic, from another user, reuses it without embedding again', async () => {
    const first = await createNotebook();
    const second = await createNotebook(BOB);
    await patch(first, { topic: 'Machine Learning' });

    const res = await patch(second, { topic: 'machine   LEARNING' }, BOB);

    // Topics are shared: Bob's notebook points at the same row, with the first wording.
    expect(notebookSchema.parse(res.body).topic?.name).toBe('Machine Learning');
    expect(await topicRows()).toHaveLength(1);
    expect(embeddings.calls).toHaveLength(1);
  });

  it('a synonym is a separate topic (related later by similarity, never merged)', async () => {
    const notebookId = await createNotebook();
    await patch(notebookId, { topic: 'Machine Learning' });

    const res = await patch(notebookId, { topic: 'ML' });

    expect(notebookSchema.parse(res.body).topic?.name).toBe('ML');
    expect((await topicRows()).map((t) => t.name).sort()).toEqual(['ML', 'Machine Learning']);
  });

  it('parallel requests for one new topic create a single row', async () => {
    const a = await createNotebook();
    const b = await createNotebook();

    const results = await Promise.all([
      patch(a, { topic: 'Statistics' }),
      patch(b, { topic: 'statistics' }),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await topicRows();
    expect(rows).toHaveLength(1);
    expect(results.map((r) => notebookSchema.parse(r.body).topic?.id)).toEqual([
      rows[0]?.id,
      rows[0]?.id,
    ]);
  });

  it('null clears the topic; the topic row stays (shared)', async () => {
    const notebookId = await createNotebook();
    await patch(notebookId, { topic: 'Statistics' });

    const res = await patch(notebookId, { topic: null });

    expect(notebookSchema.parse(res.body).topic).toBeNull();
    expect(await topicRows()).toHaveLength(1);
  });

  it('title and topic in one request; a title-only PATCH keeps the topic', async () => {
    const notebookId = await createNotebook();
    await patch(notebookId, { title: 'Stats', topic: 'Statistics' });

    const res = await patch(notebookId, { title: 'Stats 101' });

    const notebook = notebookSchema.parse(res.body);
    expect(notebook.title).toBe('Stats 101');
    expect(notebook.topic?.name).toBe('Statistics');
  });

  it('embeddings down → 503 and nothing changes', async () => {
    const notebookId = await createNotebook();
    embeddings.failNext(IngestionError.transient('timeout'));

    const res = await patch(notebookId, { title: 'Renamed', topic: 'Statistics' });

    expect(res.status).toBe(503);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('SERVICE_UNAVAILABLE');
    const [row] = await db.select().from(notebooks).where(eq(notebooks.id, notebookId));
    expect(row?.title).toBe('Notes');
    expect(row?.topicId).toBeNull();
    expect(await topicRows()).toHaveLength(0);
  });

  it("another user's notebook → 404, no topic created", async () => {
    const notebookId = await createNotebook();

    const res = await patch(notebookId, { topic: 'Statistics' }, BOB);

    expect(res.status).toBe(404);
    expect(await topicRows()).toHaveLength(0);
  });

  it('an invalid topic → 400', async () => {
    const notebookId = await createNotebook();
    expect((await patch(notebookId, { topic: '' })).status).toBe(400);
    expect((await patch(notebookId, { topic: 42 })).status).toBe(400);
  });

  it('new notebooks and the list show topic: null until one is set', async () => {
    await createNotebook();
    const list = await request(app).get('/api/v1/notebooks').set('authorization', ALICE);
    expect((list.body as { items: { topic: unknown }[] }).items[0]?.topic).toBeNull();
  });
});
