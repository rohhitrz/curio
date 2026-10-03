import {
  errorResponseSchema,
  learningPathSchema,
  moduleSchema,
  notebookDetailSchema,
  outlineSchema,
  startPathResponseSchema,
} from '@curio/shared';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { quotas } from '../../src/config/index.js';
import {
  conceptCoverage,
  concepts,
  learningPaths,
  memories,
  modules,
  notebooks,
  pathResources,
  topics,
  users,
} from '../../src/db/schema/index.js';
import { createFakeEmbeddings, type FakeEmbeddings } from '../fakes/embeddings.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { createFakeRateLimiter, type FakeRateLimiter } from '../fakes/rate-limit.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const db = getTestDb();

let jobs: FakeJobs;
let limiter: FakeRateLimiter;
let embeddings: FakeEmbeddings;
let app: ReturnType<typeof createTestApp>;

const errorCode = (body: unknown) => errorResponseSchema.parse(body).error.code;

beforeEach(async () => {
  await truncateAllTables();
  jobs = createFakeJobs();
  limiter = createFakeRateLimiter();
  embeddings = createFakeEmbeddings();
  app = createTestApp({ jobs, rateLimiter: limiter, embeddings });
});

const start = (body: object, auth = ALICE) =>
  request(app).post('/api/v1/learning-paths').set('authorization', auth).send(body);

const START = { topic: 'Deep Learning', level: 'INTERMEDIATE', goal: 'JOB' };

async function startPath(body: object = START, auth = ALICE) {
  const res = await start(body, auth);
  expect(res.status).toBe(202);
  return startPathResponseSchema.parse(res.body);
}

async function userIdOf(clerkUserId: string): Promise<string> {
  const [user] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
  if (!user) throw new Error(`no user ${clerkUserId}`);
  return user.id;
}

const setStatus = (pathId: string, values: Partial<typeof learningPaths.$inferInsert>) =>
  db.update(learningPaths).set(values).where(eq(learningPaths.id, pathId));

const get = (path: string, auth = ALICE) =>
  request(app).get(`/api/v1${path}`).set('authorization', auth);
const post = (path: string, body: object = {}, auth = ALICE) =>
  request(app).post(`/api/v1${path}`).set('authorization', auth).send(body);

describe('POST /learning-paths', () => {
  it('creates notebook + path + LEVEL memory, queues the job, and answers 202', async () => {
    const started = await startPath();

    expect(started.status).toBe('GATHERING');
    const alice = await userIdOf('user_alice');
    const [notebook] = await db
      .select()
      .from(notebooks)
      .where(eq(notebooks.id, started.notebookId));
    expect(notebook).toMatchObject({ kind: 'LEARNING', title: 'Deep Learning', userId: alice });
    const [topic] = await db.select().from(topics);
    expect(notebook?.topicId).toBe(topic?.id);
    expect(await db.select().from(memories)).toEqual([
      expect.objectContaining({
        kind: 'LEVEL',
        scope: 'TOPIC',
        topicId: topic?.id,
        level: 'INTERMEDIATE',
        origin: 'LEVEL_CONFIRMED',
        originRef: started.pathId,
      }),
    ]);
    expect(jobs.sent).toEqual([
      { name: 'path/requested', data: { pathId: started.pathId, userId: alice } },
    ]);
    expect(limiter.checks).toEqual([{ name: 'learningPaths', identifier: alice }]);

    const detail = await get(`/notebooks/${started.notebookId}`);
    expect(notebookDetailSchema.parse(detail.body).learningPathId).toBe(started.pathId);
  });

  it('a second path on the same topic updates the one LEVEL memory', async () => {
    await startPath();
    await startPath({ ...START, level: 'ADVANCED' });

    const levels = await db.select().from(memories);
    expect(levels).toHaveLength(1);
    expect(levels[0]?.level).toBe('ADVANCED');
  });

  it('invalid body → 400, nothing created', async () => {
    for (const body of [
      { ...START, level: 'EXPERT' },
      { ...START, goal: 'FUN' },
      { ...START, topic: '   ' },
      { ...START, extra: 1 },
      { topic: 'X' },
    ]) {
      const res = await start(body);
      expect(res.status).toBe(400);
      expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
    }
    expect(await db.select().from(learningPaths)).toHaveLength(0);
  });

  it('notebook cap reached → 400 QUOTA_EXCEEDED, nothing created', async () => {
    await startPath();
    const alice = await userIdOf('user_alice');
    await db.insert(notebooks).values(
      Array.from({ length: quotas.notebooksPerUser - 1 }, (_, i) => ({
        userId: alice,
        title: `N${String(i)}`,
        kind: 'SOURCE' as const,
      })),
    );

    const res = await start({ ...START, topic: 'Statistics' });

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe('QUOTA_EXCEEDED');
    expect(await db.select().from(learningPaths)).toHaveLength(1);
  });

  it('embeddings down for a new topic → 503, nothing created', async () => {
    embeddings.failNext(new Error('down'));

    const res = await start(START);

    expect(res.status).toBe(503);
    expect(await db.select().from(notebooks)).toHaveLength(0);
    expect(jobs.sent).toHaveLength(0);
  });

  it('the database failing midway → nothing created (one transaction)', async () => {
    await db.execute(sql`
      create or replace function fail_memory_insert() returns trigger as $$
      begin raise exception 'memory insert failed'; end; $$ language plpgsql`);
    await db.execute(sql`
      create trigger fail_memory_insert before insert on memories
      for each row execute function fail_memory_insert()`);
    try {
      const res = await start(START);

      expect(res.status).toBe(500);
      expect(await db.select().from(notebooks)).toHaveLength(0);
      expect(await db.select().from(learningPaths)).toHaveLength(0);
      expect(jobs.sent).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger if exists fail_memory_insert on memories`);
      await db.execute(sql`drop function if exists fail_memory_insert()`);
    }
  });

  it('the job not queued → the path is FAILED at once, so the learner can retry', async () => {
    jobs.failNextSend(new Error('inngest down'));

    const started = await startPath();

    expect(started.status).toBe('FAILED');
    const path = learningPathSchema.parse((await get(`/learning-paths/${started.pathId}`)).body);
    expect(path.error?.code).toBe('GENERATION_FAILED');
  });

  it('over the daily limit → 429, nothing created', async () => {
    limiter.denyAll(60);

    const res = await start(START);

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(await db.select().from(learningPaths)).toHaveLength(0);
  });
});

describe('GET /learning-paths/:pathId', () => {
  it('the progress poll; another user or a malformed ID → 404', async () => {
    const started = await startPath();

    const res = await get(`/learning-paths/${started.pathId}`);

    expect(res.status).toBe(200);
    expect(learningPathSchema.parse(res.body)).toMatchObject({
      id: started.pathId,
      notebookId: started.notebookId,
      topic: 'Deep Learning',
      level: 'INTERMEDIATE',
      goal: 'JOB',
      status: 'GATHERING',
      branchOptions: null,
      hook: null,
      error: null,
    });
    expect((await get(`/learning-paths/${started.pathId}`, BOB)).status).toBe(404);
    expect((await get('/learning-paths/not-a-uuid')).status).toBe(404);
  });

  it('a FAILED path shows its error', async () => {
    const started = await startPath();
    await setStatus(started.pathId, {
      status: 'FAILED',
      errorCode: 'TOO_FEW_RESOURCES',
      errorMessage: 'Only 2 of 6',
    });

    const path = learningPathSchema.parse((await get(`/learning-paths/${started.pathId}`)).body);

    expect(path.error).toEqual({ code: 'TOO_FEW_RESOURCES', message: 'Only 2 of 6' });
  });
});

describe('POST /learning-paths/:pathId/branch', () => {
  const OPTIONS = [
    { name: 'Theory', description: 'The maths' },
    { name: 'Practice', description: 'Building things' },
  ];

  it('saves the pick and wakes the job → 202', async () => {
    const started = await startPath({ ...START, level: 'ADVANCED' });
    await setStatus(started.pathId, { status: 'AWAITING_BRANCH', branchOptions: OPTIONS });
    jobs.sent.length = 0;

    const res = await post(`/learning-paths/${started.pathId}/branch`, { branch: 'Practice' });

    expect(res.status).toBe(202);
    expect(learningPathSchema.parse(res.body).selectedBranch).toBe('Practice');
    const alice = await userIdOf('user_alice');
    expect(jobs.sent).toEqual([
      { name: 'path/branch-selected', data: { pathId: started.pathId, userId: alice } },
    ]);
  });

  it('wrong status → 409; a branch not offered → 400; another user → 404', async () => {
    const started = await startPath({ ...START, level: 'ADVANCED' });
    const url = `/learning-paths/${started.pathId}/branch`;

    const early = await post(url, { branch: 'Theory' });
    expect(early.status).toBe(409);
    expect(errorCode(early.body)).toBe('INVALID_STATE');

    await setStatus(started.pathId, { status: 'AWAITING_BRANCH', branchOptions: OPTIONS });
    const unknown = await post(url, { branch: 'Cooking' });
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown.body)).toBe('VALIDATION_ERROR');
    expect((await post(url, {})).status).toBe(400);
    expect((await post(url, { branch: 'Theory' }, BOB)).status).toBe(404);
  });

  it('the wake-up not sent still saves the pick (the job reads it from the database)', async () => {
    const started = await startPath({ ...START, level: 'ADVANCED' });
    await setStatus(started.pathId, { status: 'AWAITING_BRANCH', branchOptions: OPTIONS });
    jobs.failNextSend(new Error('inngest down'));

    const res = await post(`/learning-paths/${started.pathId}/branch`, { branch: 'Theory' });

    expect(res.status).toBe(202);
    const [row] = await db.select().from(learningPaths);
    expect(row?.selectedBranch).toBe('Theory');
  });
});

describe('POST /learning-paths/:pathId/retry', () => {
  it('a FAILED path back to GATHERING with the job queued; not rate-limited', async () => {
    const started = await startPath();
    await setStatus(started.pathId, {
      status: 'FAILED',
      errorCode: 'SEARCH_FAILED',
      errorMessage: 'x',
      branchOptions: [{ name: 'A', description: 'a' }],
      selectedBranch: 'A',
    });
    jobs.sent.length = 0;
    limiter.checks.length = 0;

    const res = await post(`/learning-paths/${started.pathId}/retry`);

    expect(res.status).toBe(202);
    expect(learningPathSchema.parse(res.body)).toMatchObject({
      status: 'GATHERING',
      error: null,
      branchOptions: null,
      selectedBranch: null,
    });
    expect(jobs.sent.map((e) => e.name)).toEqual(['path/requested']);
    expect(limiter.checks).toEqual([]);
  });

  it('a path that is not FAILED → 409; another user → 404', async () => {
    const started = await startPath();

    const res = await post(`/learning-paths/${started.pathId}/retry`);

    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe('INVALID_STATE');
    expect((await post(`/learning-paths/${started.pathId}/retry`, {}, BOB)).status).toBe(404);
  });
});

/** A READY path: 2 modules (the second disabled later), 3 kept concepts, 1 skipped, 2 resources. */
async function seedReadyPath(pathId: string) {
  const [official, popular] = await db
    .insert(pathResources)
    .values([
      {
        pathId,
        role: 'OFFICIAL',
        resourceType: 'DOCS',
        title: 'Docs',
        url: 'https://docs.example',
      },
      { pathId, role: 'POPULAR', resourceType: 'VIDEO', title: 'Video', url: 'https://v.example' },
    ])
    .returning();
  const [m1, m2] = await db
    .insert(modules)
    .values([
      { pathId, position: 1, title: 'Basics', summary: 'The basics' },
      { pathId, position: 2, title: 'Training', summary: 'How it learns' },
    ])
    .returning();
  const rows = await db
    .insert(concepts)
    .values([
      {
        pathId,
        name: 'Layers',
        description: 'd',
        consensusScore: 0.5,
        status: 'INCLUDED',
        moduleId: m1?.id,
        position: 2,
      },
      {
        pathId,
        name: 'Neurons',
        description: 'd',
        consensusScore: 1,
        status: 'INCLUDED',
        moduleId: m1?.id,
        position: 1,
      },
      {
        pathId,
        name: 'Backprop',
        description: 'd',
        consensusScore: 1,
        status: 'INCLUDED',
        moduleId: m2?.id,
        position: 1,
      },
      {
        pathId,
        name: 'Kernels',
        description: 'd',
        consensusScore: 0.3,
        status: 'SKIPPED',
        skipReason: 'Covered by 1 of 2 resources, advanced',
      },
    ])
    .returning();
  const byName = new Map(rows.map((r) => [r.name, r.id]));
  await db.insert(conceptCoverage).values([
    { conceptId: byName.get('Neurons') ?? '', pathResourceId: official?.id ?? '' },
    { conceptId: byName.get('Neurons') ?? '', pathResourceId: popular?.id ?? '' },
    { conceptId: byName.get('Layers') ?? '', pathResourceId: popular?.id ?? '' },
    { conceptId: byName.get('Backprop') ?? '', pathResourceId: official?.id ?? '' },
    { conceptId: byName.get('Kernels') ?? '', pathResourceId: popular?.id ?? '' },
  ]);
  await setStatus(pathId, {
    status: 'READY',
    hook: { what: 'w', why: 'y', example: 'e', origin: 'o' },
  });
  return { m1, m2 };
}

describe('GET /learning-paths/:pathId/outline', () => {
  it('before READY → 409 PATH_NOT_READY', async () => {
    const started = await startPath();

    const res = await get(`/learning-paths/${started.pathId}/outline`);

    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe('PATH_NOT_READY');
  });

  it('hook, modules with their concepts in order, skipped list, resources, progress', async () => {
    const started = await startPath();
    await seedReadyPath(started.pathId);

    const res = await get(`/learning-paths/${started.pathId}/outline`);

    expect(res.status).toBe(200);
    const outline = outlineSchema.parse(res.body);
    expect(outline.hook).toEqual({ what: 'w', why: 'y', example: 'e', origin: 'o' });
    expect(
      outline.modules.map((m) => [m.position, m.title, m.concepts.map((c) => c.name)]),
    ).toEqual([
      [1, 'Basics', ['Neurons', 'Layers']],
      [2, 'Training', ['Backprop']],
    ]);
    expect(outline.modules[0]?.concepts[0]).toMatchObject({ coveredBy: 2, officialCovers: true });
    expect(outline.modules[0]?.concepts[1]).toMatchObject({ coveredBy: 1, officialCovers: false });
    expect(outline.modules[0]).toMatchObject({
      isEnabled: true,
      completedAt: null,
      hasLesson: false,
    });
    expect(outline.skipped).toEqual([
      { name: 'Kernels', reason: 'Covered by 1 of 2 resources, advanced' },
    ]);
    expect(outline.resources.map((r) => [r.role, r.type, r.title])).toEqual([
      ['OFFICIAL', 'DOCS', 'Docs'],
      ['POPULAR', 'VIDEO', 'Video'],
    ]);
    expect(outline.progress).toEqual({ completed: 0, enabled: 2 });
    expect((await get(`/learning-paths/${started.pathId}/outline`, BOB)).status).toBe(404);
  });
});

describe('PATCH /modules/:moduleId', () => {
  it('turns a module off and on; progress counts enabled modules', async () => {
    const started = await startPath();
    const { m2 } = await seedReadyPath(started.pathId);
    const patch = (body: object, auth = ALICE) =>
      request(app)
        .patch(`/api/v1/modules/${m2?.id ?? ''}`)
        .set('authorization', auth)
        .send(body);

    const off = await patch({ isEnabled: false });

    expect(off.status).toBe(200);
    expect(moduleSchema.parse(off.body)).toMatchObject({ id: m2?.id, isEnabled: false });
    const outline = outlineSchema.parse(
      (await get(`/learning-paths/${started.pathId}/outline`)).body,
    );
    expect(outline.progress).toEqual({ completed: 0, enabled: 1 });
    expect(moduleSchema.parse((await patch({ isEnabled: true })).body).isEnabled).toBe(true);
  });

  it('invalid body → 400; another user or unknown module → 404', async () => {
    const started = await startPath();
    const { m1 } = await seedReadyPath(started.pathId);
    const url = `/api/v1/modules/${m1?.id ?? ''}`;

    expect((await request(app).patch(url).set('authorization', ALICE).send({})).status).toBe(400);
    expect(
      (await request(app).patch(url).set('authorization', ALICE).send({ isEnabled: 'yes' })).status,
    ).toBe(400);
    expect(
      (await request(app).patch(url).set('authorization', BOB).send({ isEnabled: false })).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/v1/modules/${crypto.randomUUID()}`)
          .set('authorization', ALICE)
          .send({ isEnabled: false })
      ).status,
    ).toBe(404);
  });
});
