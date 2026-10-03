import { errorResponseSchema, memoryListSchema, memorySchema } from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { quotas } from '../../src/config/index.js';
import { topics, users } from '../../src/db/schema/index.js';
import { createMemoriesRepository } from '../../src/repositories/memories.repository.js';
import { fakeVector } from '../fakes/embeddings.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const db = getTestDb();
const repository = createMemoriesRepository(db);
const app = createTestApp();
const CAP = quotas.memoriesPerUser;

const errorCode = (body: unknown) => errorResponseSchema.parse(body).error.code;

/** Signs the user in once (creating the row) and returns their ID. */
async function userId(auth: string, clerkUserId: string): Promise<string> {
  await request(app).get('/api/v1/memories').set('authorization', auth);
  const [user] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
  if (!user) throw new Error(`no user ${clerkUserId}`);
  return user.id;
}

let alice: string;
let bob: string;
let topicId: string;

beforeEach(async () => {
  await truncateAllTables();
  alice = await userId(ALICE, 'user_alice');
  bob = await userId(BOB, 'user_bob');
  const [topic] = await db
    .insert(topics)
    .values({ name: 'Statistics', normalizedName: 'statistics', embedding: fakeVector('s') })
    .returning();
  if (!topic) throw new Error('topic missing');
  topicId = topic.id;
});

async function addFact(user: string, content: string, topic: string | null = null) {
  const row = await repository.insertWithinCap(
    user,
    { topicId: topic, kind: 'FACT', content, origin: 'CHAT_EXTRACTED' },
    CAP,
  );
  if (!row) throw new Error('not created');
  return row;
}

async function addLevel(user: string) {
  const row = await repository.upsertLevel(
    user,
    { topicId, level: 'BEGINNER', content: 'Beginner', origin: 'LEVEL_CONFIRMED' },
    CAP,
  );
  if (!row) throw new Error('not created');
  return row;
}

const list = (query = '', auth = ALICE) =>
  request(app).get(`/api/v1/memories${query}`).set('authorization', auth);
const patch = (id: string, body: object, auth = ALICE) =>
  request(app).patch(`/api/v1/memories/${id}`).set('authorization', auth).send(body);

describe('GET /memories', () => {
  it("lists the user's memories with topic and origin label, newest first", async () => {
    await addFact(alice, 'Is a nurse.');
    await addFact(alice, 'Knows the mean.', topicId);
    await addFact(bob, 'Bob fact.');

    const res = await list();

    expect(res.status).toBe(200);
    const { items } = memoryListSchema.parse(res.body);
    expect(items.map((m) => m.content)).toEqual(['Knows the mean.', 'Is a nurse.']);
    expect(items[0]).toMatchObject({
      scope: 'TOPIC',
      topic: { id: topicId, name: 'Statistics' },
      origin: 'CHAT_EXTRACTED',
      originLabel: 'Noted from a chat',
    });
    expect(items[1]?.topic).toBeNull();
  });

  it('filters by scope, topic and since', async () => {
    const first = await addFact(alice, 'Is a nurse.');
    await addFact(alice, 'Knows the mean.', topicId);
    const since = new Date(first.createdAt.getTime() + 1).toISOString();

    const contents = async (query: string) =>
      memoryListSchema.parse((await list(query)).body).items.map((m) => m.content);

    expect(await contents('?scope=GLOBAL')).toEqual(['Is a nurse.']);
    expect(await contents(`?topicId=${topicId}`)).toEqual(['Knows the mean.']);
    expect(await contents(`?since=${encodeURIComponent(since)}`)).toEqual(['Knows the mean.']);
  });

  it('invalid filters → 400; signed out → 401', async () => {
    expect((await list('?scope=NOPE')).status).toBe(400);
    expect((await list('?since=yesterday')).status).toBe(400);
    expect((await list('?topicId=1')).status).toBe(400);
    expect((await request(app).get('/api/v1/memories')).status).toBe(401);
  });
});

describe('PATCH /memories/:id', () => {
  it('editing the text makes it USER_EDITED', async () => {
    const memory = await addFact(alice, 'Is a nurse.');

    const res = await patch(memory.id, { content: '  Is an ICU nurse. ' });

    expect(res.status).toBe(200);
    expect(memorySchema.parse(res.body)).toMatchObject({
      content: 'Is an ICU nurse.',
      origin: 'USER_EDITED',
      originLabel: 'Edited by you',
    });
  });

  it('level on a LEVEL memory works; on any other memory → 400', async () => {
    const level = await addLevel(alice);
    const fact = await addFact(alice, 'Is a nurse.');

    const ok = await patch(level.id, { level: 'ADVANCED' });
    expect(memorySchema.parse(ok.body)).toMatchObject({ level: 'ADVANCED', origin: 'USER_EDITED' });

    const bad = await patch(fact.id, { level: 'ADVANCED' });
    expect(bad.status).toBe(400);
    expect(errorCode(bad.body)).toBe('VALIDATION_ERROR');
    expect((await repository.findById(alice, fact.id))?.origin).toBe('CHAT_EXTRACTED');
  });

  it('empty body, empty or too long text, other fields → 400', async () => {
    const memory = await addFact(alice, 'Is a nurse.');
    expect((await patch(memory.id, {})).status).toBe(400);
    expect((await patch(memory.id, { content: '  ' })).status).toBe(400);
    expect((await patch(memory.id, { content: 'x'.repeat(301) })).status).toBe(400);
    expect((await patch(memory.id, { origin: 'CHAT_EXTRACTED' })).status).toBe(400);
  });

  it("another user's memory or a malformed id → 404", async () => {
    const memory = await addFact(alice, 'Is a nurse.');
    expect((await patch(memory.id, { content: 'x' }, BOB)).status).toBe(404);
    expect((await patch('not-a-uuid', { content: 'x' })).status).toBe(404);
    expect((await repository.findById(alice, memory.id))?.content).toBe('Is a nurse.');
  });
});

describe('DELETE /memories', () => {
  it('deletes one; again → 404; not another user’s', async () => {
    const memory = await addFact(alice, 'Is a nurse.');
    const del = (auth: string) =>
      request(app).delete(`/api/v1/memories/${memory.id}`).set('authorization', auth);

    expect((await del(BOB)).status).toBe(404);
    expect((await del(ALICE)).status).toBe(204);
    expect((await del(ALICE)).status).toBe(404);
  });

  it("delete all: all of the user's memories gone, other users' untouched", async () => {
    await addFact(alice, 'A.');
    await addFact(alice, 'B.', topicId);
    await addFact(bob, 'C.');

    const res = await request(app).delete('/api/v1/memories').set('authorization', ALICE);

    expect(res.status).toBe(204);
    expect(await repository.count(alice)).toBe(0);
    expect(await repository.count(bob)).toBe(1);
  });
});
