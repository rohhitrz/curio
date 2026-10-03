import { errorResponseSchema, prefillResponseSchema } from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { learningPaths as learningPathsConfig } from '../../src/config/index.js';
import { memories, topics, users } from '../../src/db/schema/index.js';
import type { EmbeddingsProvider } from '../../src/lib/embeddings/index.js';
import { fakeVector, type FakeEmbeddings } from '../fakes/embeddings.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const db = getTestDb();

const unit = (v: number[]) => {
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};
const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

/** `base` moved toward a random direction until their cosine similarity is about `similarity`. */
function vectorAt(base: number[], similarity: number, seed: string): number[] {
  const noise = fakeVector(seed);
  const orthogonal = unit(noise.map((x, i) => x - dot(noise, base) * (base[i] ?? 0)));
  const sin = Math.sqrt(1 - similarity ** 2);
  return unit(base.map((x, i) => similarity * x + sin * (orthogonal[i] ?? 0)));
}

const ML = fakeVector('machine learning');
const vectors: Record<string, number[]> = {
  'Machine Learning': ML,
  'Deep Learning': vectorAt(ML, 0.8, 'dl'),
  Statistics: vectorAt(ML, 0.65, 'stats'),
  'Medieval History': vectorAt(ML, 0.2, 'history'),
};

let embeddings: FakeEmbeddings;
let app: ReturnType<typeof createTestApp>;

/** Embeddings with chosen vectors per topic name, so similarities are known. */
function createTopicEmbeddings(): FakeEmbeddings {
  const calls: string[][] = [];
  const failures: Error[] = [];
  const provider: EmbeddingsProvider = {
    model: 'fake-embedding-model',
    embed(texts) {
      calls.push(texts);
      const failure = failures.shift();
      if (failure) return Promise.reject(failure);
      return Promise.resolve(texts.map((text) => vectors[text] ?? fakeVector(text)));
    },
  };
  return { provider, calls, failNext: (...errors: Error[]) => failures.push(...errors) };
}

beforeEach(async () => {
  await truncateAllTables();
  embeddings = createTopicEmbeddings();
  app = createTestApp({ embeddings });
});

async function userId(auth: string, clerkUserId: string): Promise<string> {
  await request(app).get('/api/v1/memories').set('authorization', auth);
  const [user] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
  if (!user) throw new Error(`no user ${clerkUserId}`);
  return user.id;
}

async function createTopic(name: string): Promise<string> {
  const [row] = await db
    .insert(topics)
    .values({ name, normalizedName: name.toLowerCase(), embedding: vectors[name] ?? [] })
    .returning();
  if (!row) throw new Error('topic not created');
  return row.id;
}

async function confirmLevel(
  user: string,
  topicId: string,
  level: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED',
) {
  await db.insert(memories).values({
    userId: user,
    scope: 'TOPIC',
    topicId,
    kind: 'LEVEL',
    level,
    content: `Level: ${level}`,
    origin: 'LEVEL_CONFIRMED',
  });
}

async function prefill(topic: string, auth = ALICE) {
  const res = await request(app)
    .get('/api/v1/learning-paths/prefill')
    .query({ topic })
    .set('authorization', auth);
  expect(res.status).toBe(200);
  return prefillResponseSchema.parse(res.body).match;
}

describe('GET /learning-paths/prefill', () => {
  it('the test vectors sit where the threshold needs them', () => {
    const threshold = learningPathsConfig.relatedTopicMinSimilarity;
    expect(dot(ML, vectors['Deep Learning'] ?? [])).toBeGreaterThan(threshold);
    expect(dot(ML, vectors['Medieval History'] ?? [])).toBeLessThan(threshold);
  });

  it('no levels yet → no match, without an embeddings call', async () => {
    await createTopic('Machine Learning');

    expect(await prefill('Machine Learning')).toBeNull();
    expect(embeddings.calls).toEqual([]);
  });

  it('same topic (any spelling) → EXACT with the stored name, without an embeddings call', async () => {
    const alice = await userId(ALICE, 'user_alice');
    await confirmLevel(alice, await createTopic('Machine Learning'), 'INTERMEDIATE');

    expect(await prefill('  machine   LEARNING ')).toEqual({
      type: 'EXACT',
      topicName: 'Machine Learning',
      level: 'INTERMEDIATE',
    });
    expect(embeddings.calls).toEqual([]);
  });

  it('a new, similar topic → RELATED; the topic is embedded but not created', async () => {
    const alice = await userId(ALICE, 'user_alice');
    await confirmLevel(alice, await createTopic('Machine Learning'), 'BEGINNER');

    expect(await prefill('Deep Learning')).toEqual({
      type: 'RELATED',
      topicName: 'Machine Learning',
      level: 'BEGINNER',
    });
    expect(embeddings.calls).toEqual([['Deep Learning']]);
    expect(await db.select().from(topics)).toHaveLength(1);
  });

  it('a known topic without a level uses its stored embedding', async () => {
    const alice = await userId(ALICE, 'user_alice');
    await confirmLevel(alice, await createTopic('Machine Learning'), 'ADVANCED');
    await createTopic('Deep Learning');

    expect((await prefill('Deep Learning'))?.type).toBe('RELATED');
    expect(embeddings.calls).toEqual([]);
  });

  it('the most similar of several studied topics wins', async () => {
    const alice = await userId(ALICE, 'user_alice');
    await confirmLevel(alice, await createTopic('Statistics'), 'ADVANCED');
    await confirmLevel(alice, await createTopic('Machine Learning'), 'BEGINNER');

    expect(await prefill('Deep Learning')).toMatchObject({
      topicName: 'Machine Learning',
      level: 'BEGINNER',
    });
  });

  it('an unrelated topic → no match', async () => {
    const alice = await userId(ALICE, 'user_alice');
    await confirmLevel(alice, await createTopic('Machine Learning'), 'BEGINNER');

    expect(await prefill('Medieval History')).toBeNull();
  });

  it("another user's levels are never offered", async () => {
    const bob = await userId(BOB, 'user_bob');
    await confirmLevel(bob, await createTopic('Machine Learning'), 'ADVANCED');
    await userId(ALICE, 'user_alice');

    expect(await prefill('Machine Learning')).toBeNull();
    expect(await prefill('Deep Learning')).toBeNull();
  });

  it('embeddings down → no match (200), the learner just picks', async () => {
    const alice = await userId(ALICE, 'user_alice');
    await confirmLevel(alice, await createTopic('Machine Learning'), 'BEGINNER');
    embeddings.failNext(new Error('embeddings down'));

    expect(await prefill('Deep Learning')).toBeNull();
  });

  it('missing, blank, too long or extra query → 400; signed out → 401', async () => {
    const get = (query: Record<string, string>) =>
      request(app).get('/api/v1/learning-paths/prefill').query(query).set('authorization', ALICE);

    const queries: Record<string, string>[] = [
      {},
      { topic: '   ' },
      { topic: 'x'.repeat(500) },
      { topic: 'ML', x: '1' },
    ];
    for (const query of queries) {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(errorResponseSchema.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    }
    expect(
      (await request(app).get('/api/v1/learning-paths/prefill').query({ topic: 'ML' })).status,
    ).toBe(401);
  });
});
