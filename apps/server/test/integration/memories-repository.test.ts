import { notebookSchema } from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { quotas } from '../../src/config/index.js';
import { memories, topics, users } from '../../src/db/schema/index.js';
import {
  createMemoriesRepository,
  type NewMemory,
} from '../../src/repositories/memories.repository.js';
import { fakeVector } from '../fakes/embeddings.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';
import { seedConcept, seedLearningPath } from '../helpers/learning.js';

const db = getTestDb();
const repository = createMemoriesRepository(db);
const CAP = quotas.memoriesPerUser;

let alice: string;
let bob: string;
let topicId: string;
let otherTopicId: string;

async function createUser(clerkUserId: string): Promise<string> {
  const [row] = await db.insert(users).values({ clerkUserId }).returning();
  if (!row) throw new Error('user not created');
  return row.id;
}

async function createTopic(name: string): Promise<string> {
  const [row] = await db
    .insert(topics)
    .values({ name, normalizedName: name.toLowerCase(), embedding: fakeVector(name) })
    .returning();
  if (!row) throw new Error('topic not created');
  return row.id;
}

const fact = (content: string, overrides: Partial<NewMemory> = {}): NewMemory => ({
  topicId: null,
  kind: 'FACT',
  content,
  origin: 'CHAT_EXTRACTED',
  ...overrides,
});

/** `count` raw rows for `userId`, bypassing the cap. */
async function seed(userId: string, count: number) {
  await db.insert(memories).values(
    Array.from({ length: count }, (_, i) => ({
      userId,
      scope: 'GLOBAL' as const,
      kind: 'FACT' as const,
      content: `Fact ${i}`,
      origin: 'CHAT_EXTRACTED' as const,
    })),
  );
}

/** Postgres error code of a rejected query (drizzle wraps the driver error as `cause`). */
async function pgCode(query: Promise<unknown>): Promise<string | undefined> {
  try {
    await query;
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ?? (err as { code?: string }).code;
  }
  return undefined;
}

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

beforeEach(async () => {
  await truncateAllTables();
  alice = await createUser('user_alice');
  bob = await createUser('user_bob');
  topicId = await createTopic('Statistics');
  otherTopicId = await createTopic('Biology');
});

describe('memories: database checks', () => {
  const base = { kind: 'FACT' as const, content: 'x', origin: 'CHAT_EXTRACTED' as const };

  it('TOPIC memory without a topic / GLOBAL memory with a topic → rejected', async () => {
    expect(
      await pgCode(db.insert(memories).values({ ...base, userId: alice, scope: 'TOPIC' })),
    ).toBe(CHECK_VIOLATION);
    expect(
      await pgCode(
        db.insert(memories).values({ ...base, userId: alice, scope: 'GLOBAL', topicId }),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('LEVEL needs a level and a topic', async () => {
    const level = { ...base, userId: alice, kind: 'LEVEL' as const };
    expect(await pgCode(db.insert(memories).values({ ...level, scope: 'TOPIC', topicId }))).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await pgCode(db.insert(memories).values({ ...level, scope: 'GLOBAL', level: 'BEGINNER' })),
    ).toBe(CHECK_VIOLATION);
  });

  it('second LEVEL for the same topic → rejected by the unique index', async () => {
    const level = {
      ...base,
      userId: alice,
      scope: 'TOPIC' as const,
      topicId,
      kind: 'LEVEL' as const,
      level: 'BEGINNER' as const,
    };
    await db.insert(memories).values(level);
    expect(await pgCode(db.insert(memories).values({ ...level, level: 'ADVANCED' }))).toBe(
      UNIQUE_VIOLATION,
    );
    // Another user, or another topic, is fine.
    await db.insert(memories).values({ ...level, userId: bob });
    await db.insert(memories).values({ ...level, topicId: otherTopicId });
  });

  it('second UNDERSTOOD for the same concept → rejected', async () => {
    const { path } = await seedLearningPath(alice);
    const concept = await seedConcept(path.id);
    const understood = {
      ...base,
      userId: alice,
      scope: 'TOPIC' as const,
      topicId,
      kind: 'UNDERSTOOD' as const,
      conceptId: concept.id,
    };
    await db.insert(memories).values(understood);
    expect(await pgCode(db.insert(memories).values(understood))).toBe(UNIQUE_VIOLATION);
  });
});

describe('memories repository', () => {
  it('insert sets the scope from the topic and returns the topic name', async () => {
    const global = await repository.insertWithinCap(alice, fact('Prefers examples'), CAP);
    const scoped = await repository.insertWithinCap(
      alice,
      fact('Knows what a p-value is', { topicId }),
      CAP,
    );

    expect(global).toMatchObject({ scope: 'GLOBAL', topicId: null, topicName: null });
    expect(scoped).toMatchObject({ scope: 'TOPIC', topicId, topicName: 'Statistics' });
  });

  it('upsertLevel: a second level for the topic updates the one row', async () => {
    const first = await repository.upsertLevel(
      alice,
      { topicId, level: 'BEGINNER', content: 'Beginner', origin: 'LEVEL_CONFIRMED' },
      CAP,
    );
    const second = await repository.upsertLevel(
      alice,
      { topicId, level: 'INTERMEDIATE', content: 'Intermediate', origin: 'LEVEL_CONFIRMED' },
      CAP,
    );

    expect(second?.id).toBe(first?.id);
    expect(second?.level).toBe('INTERMEDIATE');
    const rows = await db.select().from(memories).where(eq(memories.userId, alice));
    expect(rows).toHaveLength(1);
  });

  it('cap reached: no new memories beyond it; updating an existing level still works', async () => {
    await repository.upsertLevel(
      alice,
      { topicId, level: 'BEGINNER', content: 'Beginner', origin: 'LEVEL_CONFIRMED' },
      CAP,
    );
    await seed(alice, CAP - 1);

    expect(await repository.insertWithinCap(alice, fact('One too many'), CAP)).toBeUndefined();
    expect(
      await repository.upsertLevel(
        alice,
        { topicId: otherTopicId, level: 'BEGINNER', content: 'New', origin: 'LEVEL_CONFIRMED' },
        CAP,
      ),
    ).toBeUndefined();
    const updated = await repository.upsertLevel(
      alice,
      { topicId, level: 'ADVANCED', content: 'Advanced', origin: 'LEVEL_CONFIRMED' },
      CAP,
    );
    expect(updated?.level).toBe('ADVANCED');
    expect(await repository.count(alice)).toBe(CAP);
    // Bob has his own cap.
    expect(await repository.insertWithinCap(bob, fact('Bob fact'), CAP)).toBeDefined();
  });

  it('parallel inserts one below the cap: exactly one succeeds', async () => {
    await seed(alice, CAP - 1);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => repository.insertWithinCap(alice, fact(`P${i}`), CAP)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repository.count(alice)).toBe(CAP);
  });

  it('update with unlessUserEdited never touches a user-edited memory', async () => {
    const edited = await repository.insertWithinCap(
      alice,
      fact('Likes diagrams', { origin: 'USER_EDITED' }),
      CAP,
    );
    const extracted = await repository.insertWithinCap(alice, fact('Likes lists'), CAP);
    if (!edited || !extracted) throw new Error('not created');

    const skipped = await repository.update(
      alice,
      edited.id,
      { content: 'Overwritten' },
      { unlessUserEdited: true },
    );
    const changed = await repository.update(
      alice,
      extracted.id,
      { content: 'Likes numbered lists' },
      { unlessUserEdited: true },
    );

    expect(skipped).toBeUndefined();
    expect((await repository.findById(alice, edited.id))?.content).toBe('Likes diagrams');
    expect(changed?.content).toBe('Likes numbered lists');
    // The user's own edit goes through.
    const byUser = await repository.update(alice, edited.id, {
      content: 'Likes flowcharts',
      origin: 'USER_EDITED',
    });
    expect(byUser?.content).toBe('Likes flowcharts');
  });

  it("another user's memory reads, updates and deletes as missing", async () => {
    const memory = await repository.insertWithinCap(alice, fact('Alice fact'), CAP);
    if (!memory) throw new Error('not created');

    expect(await repository.findById(bob, memory.id)).toBeUndefined();
    expect(await repository.update(bob, memory.id, { content: 'x' })).toBeUndefined();
    expect(await repository.delete(bob, memory.id)).toBe(false);
    expect((await repository.findById(alice, memory.id))?.content).toBe('Alice fact');
  });

  it("delete all: all of the user's memories gone, other users' untouched", async () => {
    await seed(alice, 3);
    await seed(bob, 2);

    expect(await repository.deleteAll(alice)).toBe(3);
    expect(await repository.count(alice)).toBe(0);
    expect(await repository.count(bob)).toBe(2);
  });

  it('list: newest first, filtered by scope, topic and since', async () => {
    const old = await repository.insertWithinCap(alice, fact('Old global'), CAP);
    if (!old) throw new Error('not created');
    await repository.insertWithinCap(alice, fact('Stats fact', { topicId }), CAP);
    await repository.insertWithinCap(alice, fact('Bio fact', { topicId: otherTopicId }), CAP);
    await repository.insertWithinCap(bob, fact('Bob fact'), CAP);

    expect((await repository.list(alice)).map((m) => m.content)).toEqual([
      'Bio fact',
      'Stats fact',
      'Old global',
    ]);
    expect((await repository.list(alice, { scope: 'GLOBAL' })).map((m) => m.content)).toEqual([
      'Old global',
    ]);
    expect((await repository.list(alice, { topicId })).map((m) => m.content)).toEqual([
      'Stats fact',
    ]);
    // JS dates are milliseconds, Postgres keeps microseconds: start 1 ms after the old row.
    expect(
      (await repository.list(alice, { since: new Date(old.createdAt.getTime() + 1) }))
        .map((m) => m.content)
        .sort(),
    ).toEqual(['Bio fact', 'Stats fact']);
  });
});

describe('deleting a notebook', () => {
  it('keeps the memories', async () => {
    const app = createTestApp();
    const auth = bearer('user_alice');
    const created = await request(app)
      .post('/api/v1/notebooks')
      .set('authorization', auth)
      .send({ title: 'Stats' });
    const notebookId = notebookSchema.parse(created.body).id;
    await request(app)
      .patch(`/api/v1/notebooks/${notebookId}`)
      .set('authorization', auth)
      .send({ topic: 'Statistics' });
    await repository.insertWithinCap(alice, fact('Knows the mean', { topicId }), CAP);

    const res = await request(app)
      .delete(`/api/v1/notebooks/${notebookId}`)
      .set('authorization', auth);

    expect(res.status).toBe(204);
    expect(await repository.count(alice)).toBe(1);
  });
});
