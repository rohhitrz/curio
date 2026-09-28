import {
  errorResponseSchema,
  notebookDetailSchema,
  notebookSchema,
  paginatedResponseSchema,
  type Notebook,
} from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { quotas } from '../../src/config/index.js';
import { notebooks, users } from '../../src/db/schema/index.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const app = createTestApp();
const listSchema = paginatedResponseSchema(notebookSchema);
const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');

async function createNotebook(auth: string, title: string): Promise<Notebook> {
  const res = await request(app)
    .post('/api/v1/notebooks')
    .set('authorization', auth)
    .send({ title });
  expect(res.status).toBe(201);
  return notebookSchema.parse(res.body);
}

function errorCode(body: unknown) {
  return errorResponseSchema.parse(body).error.code;
}

beforeEach(async () => {
  await truncateAllTables();
});

describe('notebooks CRUD', () => {
  it('create → 201 as a SOURCE notebook with a trimmed title', async () => {
    const notebook = await createNotebook(ALICE, '  Quantum physics  ');

    expect(notebook).toMatchObject({ title: 'Quantum physics', kind: 'SOURCE' });
  });

  it('get → 200 with counts', async () => {
    const created = await createNotebook(ALICE, 'Biology');

    const res = await request(app)
      .get(`/api/v1/notebooks/${created.id}`)
      .set('authorization', ALICE);

    expect(res.status).toBe(200);
    expect(notebookDetailSchema.parse(res.body)).toEqual({
      ...created,
      sourceCount: 0,
      conversationCount: 0,
      learningPathId: null,
    });
  });

  it('list → 200 with the user’s notebooks, most recently updated first', async () => {
    const first = await createNotebook(ALICE, 'First');
    const second = await createNotebook(ALICE, 'Second');

    const res = await request(app).get('/api/v1/notebooks').set('authorization', ALICE);

    expect(res.status).toBe(200);
    const body = listSchema.parse(res.body);
    expect(body.items.map((n) => n.id)).toEqual([second.id, first.id]);
    expect(body.nextCursor).toBeNull();
  });

  it('rename → 200 and bumps updatedAt', async () => {
    const created = await createNotebook(ALICE, 'Old name');

    const res = await request(app)
      .patch(`/api/v1/notebooks/${created.id}`)
      .set('authorization', ALICE)
      .send({ title: 'New name' });

    expect(res.status).toBe(200);
    const renamed = notebookSchema.parse(res.body);
    expect(renamed.title).toBe('New name');
    expect(Date.parse(renamed.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));
  });

  it('delete → 204, then 404', async () => {
    const created = await createNotebook(ALICE, 'Temporary');

    const del = await request(app)
      .delete(`/api/v1/notebooks/${created.id}`)
      .set('authorization', ALICE);
    expect(del.status).toBe(204);

    const get = await request(app)
      .get(`/api/v1/notebooks/${created.id}`)
      .set('authorization', ALICE);
    expect(get.status).toBe(404);
  });
});

describe('notebooks validation', () => {
  it('POST with kind: LEARNING → 400', async () => {
    const res = await request(app)
      .post('/api/v1/notebooks')
      .set('authorization', ALICE)
      .send({ title: 'Sneaky', kind: 'LEARNING' });

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['missing title', {}],
    ['blank title', { title: '   ' }],
    ['too long', { title: 'x'.repeat(201) }],
  ])('POST with %s → 400 with field details', async (_label, body) => {
    const res = await request(app).post('/api/v1/notebooks').set('authorization', ALICE).send(body);

    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(res.body).error.details).toHaveProperty('title');
  });

  it('PATCH with nothing to update → 400', async () => {
    const created = await createNotebook(ALICE, 'Physics');

    const res = await request(app)
      .patch(`/api/v1/notebooks/${created.id}`)
      .set('authorization', ALICE)
      .send({});

    expect(res.status).toBe(400);
  });

  it('malformed notebook ID → 404', async () => {
    const res = await request(app).get('/api/v1/notebooks/not-a-uuid').set('authorization', ALICE);

    expect(res.status).toBe(404);
  });

  it('limit above the max → 400', async () => {
    const res = await request(app).get('/api/v1/notebooks?limit=500').set('authorization', ALICE);

    expect(res.status).toBe(400);
  });

  it('tampered cursor → 400', async () => {
    const res = await request(app)
      .get('/api/v1/notebooks?cursor=garbage')
      .set('authorization', ALICE);

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });
});

describe('notebooks ownership', () => {
  it('another user’s notebook → 404 on get, patch, delete, and it is left untouched', async () => {
    const alices = await createNotebook(ALICE, 'Private');
    const path = `/api/v1/notebooks/${alices.id}`;

    const get = await request(app).get(path).set('authorization', BOB);
    const patch = await request(app)
      .patch(path)
      .set('authorization', BOB)
      .send({ title: 'Hacked' });
    const del = await request(app).delete(path).set('authorization', BOB);

    expect([get.status, patch.status, del.status]).toEqual([404, 404, 404]);
    expect(errorCode(get.body)).toBe('NOT_FOUND');

    const stillThere = await request(app).get(path).set('authorization', ALICE);
    expect(notebookSchema.parse(stillThere.body).title).toBe('Private');
  });

  it('list only shows the caller’s notebooks', async () => {
    await createNotebook(ALICE, 'Alice’s');
    await createNotebook(BOB, 'Bob’s');

    const res = await request(app).get('/api/v1/notebooks').set('authorization', BOB);

    expect(listSchema.parse(res.body).items.map((n) => n.title)).toEqual(['Bob’s']);
  });
});

describe('notebooks pagination', () => {
  async function collectAll(limit: number) {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await request(app)
        .get('/api/v1/notebooks')
        .query(cursor ? { limit, cursor } : { limit })
        .set('authorization', ALICE);
      expect(res.status).toBe(200);
      const body = listSchema.parse(res.body);
      expect(body.items.length).toBeLessThanOrEqual(limit);
      seen.push(...body.items.map((n) => n.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    return { seen, pages };
  }

  it('cursor returns the next page with no duplicates or gaps', async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) created.push((await createNotebook(ALICE, `N${i}`)).id);

    const { seen, pages } = await collectAll(2);

    expect(pages).toBe(3);
    expect(seen).toEqual([...created].reverse());
  });

  it('rows with identical updatedAt are neither duplicated nor skipped', async () => {
    await createNotebook(ALICE, 'seed'); // creates the user row
    const db = getTestDb();
    const [alice] = await db.select().from(users).where(eq(users.clerkUserId, 'user_alice'));
    if (!alice) throw new Error('alice missing');
    const sameTime = new Date('2026-01-01T00:00:00.000Z');
    await db.insert(notebooks).values(
      Array.from({ length: 6 }, (_, i) => ({
        userId: alice.id,
        title: `Tie ${i}`,
        kind: 'SOURCE' as const,
        createdAt: sameTime,
        updatedAt: sameTime,
      })),
    );

    const { seen } = await collectAll(4);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });
});

describe('notebooks quota', () => {
  async function seedNotebooks(count: number) {
    await createNotebook(ALICE, 'seed');
    const db = getTestDb();
    const [alice] = await db.select().from(users).where(eq(users.clerkUserId, 'user_alice'));
    if (!alice) throw new Error('alice missing');
    await db.insert(notebooks).values(
      Array.from({ length: count - 1 }, (_, i) => ({
        userId: alice.id,
        title: `Seed ${i}`,
        kind: 'SOURCE' as const,
      })),
    );
  }

  it(`creating notebook #${quotas.notebooksPerUser + 1} → 400 QUOTA_EXCEEDED`, async () => {
    await seedNotebooks(quotas.notebooksPerUser);

    const res = await request(app)
      .post('/api/v1/notebooks')
      .set('authorization', ALICE)
      .send({ title: 'One too many' });

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe('QUOTA_EXCEEDED');
  });

  it('parallel creates cannot exceed the quota', async () => {
    await seedNotebooks(quotas.notebooksPerUser - 2);

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(app)
          .post('/api/v1/notebooks')
          .set('authorization', ALICE)
          .send({ title: `P${i}` }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(2);
    expect(responses.filter((r) => r.status === 400)).toHaveLength(3);
  });
});
