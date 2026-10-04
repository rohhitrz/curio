import { randomUUID } from 'node:crypto';
import { errorResponseSchema } from '@curio/shared';
import { asc, getTableName, type Table } from 'drizzle-orm';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  concepts,
  conversations,
  learningPaths,
  lessons,
  memories,
  messages,
  modules,
  notebooks,
  sources,
  topics,
  users,
} from '../../src/db/schema/index.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { createFakeLlm, type FakeLlm } from '../fakes/llm.js';
import { createFakeStorage, type FakeStorage } from '../fakes/storage.js';
import { fakeVector } from '../fakes/embeddings.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

/**
 * Phase 10.3: every endpoint that takes an ID, called by Bob on Alice's resource → 404, with
 * nothing of Alice's changed and nothing sent or generated. Each case also runs as Alice, who
 * must not get a 404, so a wrong seed can't make the check pass.
 */

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const db = getTestDb();

let app: ReturnType<typeof createTestApp>;
let jobs: FakeJobs;
let llm: FakeLlm;
let storage: FakeStorage;
let ids: Awaited<ReturnType<typeof seedAlice>>;

async function one<T>(rows: Promise<T[]>): Promise<T> {
  const [row] = await rows;
  if (!row) throw new Error('seed failed');
  return row;
}

/** One of everything, all Alice's: a notebook with a source and a chat, a READY path with a lesson. */
async function seedAlice() {
  const user = await one(db.insert(users).values({ clerkUserId: 'user_alice' }).returning());
  const topic = await one(
    db
      .insert(topics)
      .values({
        name: 'Deep Learning',
        normalizedName: 'deep learning',
        embedding: fakeVector('dl'),
      })
      .returning(),
  );
  const notebook = await one(
    db
      .insert(notebooks)
      .values({ userId: user.id, title: 'Alice notes', kind: 'SOURCE', topicId: topic.id })
      .returning(),
  );
  const storageKey = `users/${user.id}/uploads/${randomUUID()}.pdf`;
  storage.put(storageKey, 2048);
  const source = await one(
    db
      .insert(sources)
      .values({
        notebookId: notebook.id,
        userId: user.id,
        type: 'PDF',
        title: 'Lecture',
        storageKey,
        contentHash: 'a'.repeat(64),
        status: 'READY',
        extractedText: 'Dropout drops units.',
      })
      .returning(),
  );
  const conversation = await one(
    db
      .insert(conversations)
      .values({ notebookId: notebook.id, userId: user.id, title: 'Alice chat' })
      .returning(),
  );
  await db.insert(messages).values({
    conversationId: conversation.id,
    seq: 1,
    role: 'USER',
    content: 'What is dropout?',
  });
  const answer = await one(
    db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        seq: 2,
        role: 'ASSISTANT',
        content: 'It drops units.',
      })
      .returning(),
  );

  const pathNotebook = await one(
    db
      .insert(notebooks)
      .values({ userId: user.id, title: 'Deep Learning', kind: 'LEARNING', topicId: topic.id })
      .returning(),
  );
  const path = await one(
    db
      .insert(learningPaths)
      .values({
        notebookId: pathNotebook.id,
        userId: user.id,
        topic: 'Deep Learning',
        level: 'BEGINNER',
        goal: 'JOB',
        status: 'READY',
      })
      .returning(),
  );
  const module = await one(
    db
      .insert(modules)
      .values({ pathId: path.id, position: 1, title: 'Regularization', summary: 'Generalizing' })
      .returning(),
  );
  await db.insert(concepts).values({
    pathId: path.id,
    moduleId: module.id,
    name: 'Dropout',
    description: 'Dropping units',
    consensusScore: 0.5,
    status: 'INCLUDED',
  });
  const lesson = await one(
    db
      .insert(lessons)
      .values({
        moduleId: module.id,
        version: 1,
        content: 'Dropout drops units.',
        status: 'COMPLETE',
        model: 'fake-llm',
      })
      .returning(),
  );
  const memory = await one(
    db
      .insert(memories)
      .values({
        userId: user.id,
        scope: 'GLOBAL',
        kind: 'STYLE',
        content: 'Likes code examples',
        origin: 'CHAT_EXTRACTED',
      })
      .returning(),
  );

  return {
    userId: user.id,
    topicId: topic.id,
    notebookId: notebook.id,
    sourceId: source.id,
    storageKey,
    conversationId: conversation.id,
    messageId: answer.id,
    pathId: path.id,
    moduleId: module.id,
    lessonId: lesson.id,
    memoryId: memory.id,
  };
}

type Ids = typeof ids;

interface Case {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** The route as registered, for the coverage check. */
  route: string;
  path: (ids: Ids) => string;
  body?: (ids: Ids) => object;
}

const cases: Case[] = [
  // Notebooks
  { method: 'get', route: '/notebooks/:notebookId', path: (i) => `/notebooks/${i.notebookId}` },
  {
    method: 'patch',
    route: '/notebooks/:notebookId',
    path: (i) => `/notebooks/${i.notebookId}`,
    body: () => ({ title: 'Mine now' }),
  },
  { method: 'delete', route: '/notebooks/:notebookId', path: (i) => `/notebooks/${i.notebookId}` },
  // Sources
  {
    method: 'get',
    route: '/notebooks/:notebookId/sources',
    path: (i) => `/notebooks/${i.notebookId}/sources`,
  },
  {
    method: 'post',
    route: '/notebooks/:notebookId/uploads',
    path: (i) => `/notebooks/${i.notebookId}/uploads`,
    body: () => ({ fileName: 'a.pdf', fileSize: 2048, contentType: 'application/pdf' }),
  },
  {
    method: 'post',
    route: '/notebooks/:notebookId/sources',
    path: (i) => `/notebooks/${i.notebookId}/sources`,
    body: () => ({ type: 'TEXT', title: 'Note', content: 'Hello' }),
  },
  { method: 'get', route: '/sources/:sourceId', path: (i) => `/sources/${i.sourceId}` },
  {
    method: 'patch',
    route: '/sources/:sourceId',
    path: (i) => `/sources/${i.sourceId}`,
    body: () => ({ title: 'Renamed' }),
  },
  { method: 'delete', route: '/sources/:sourceId', path: (i) => `/sources/${i.sourceId}` },
  {
    method: 'get',
    route: '/sources/:sourceId/file-url',
    path: (i) => `/sources/${i.sourceId}/file-url`,
  },
  {
    method: 'get',
    route: '/sources/:sourceId/content',
    path: (i) => `/sources/${i.sourceId}/content`,
  },
  {
    method: 'get',
    route: '/sources/:sourceId/chunks',
    path: (i) => `/sources/${i.sourceId}/chunks`,
  },
  {
    method: 'post',
    route: '/sources/:sourceId/reprocess',
    path: (i) => `/sources/${i.sourceId}/reprocess`,
  },
  // Chat
  {
    method: 'get',
    route: '/notebooks/:notebookId/conversations',
    path: (i) => `/notebooks/${i.notebookId}/conversations`,
  },
  {
    method: 'post',
    route: '/notebooks/:notebookId/conversations',
    path: (i) => `/notebooks/${i.notebookId}/conversations`,
    body: () => ({}),
  },
  {
    method: 'get',
    route: '/conversations/:conversationId',
    path: (i) => `/conversations/${i.conversationId}`,
  },
  {
    method: 'patch',
    route: '/conversations/:conversationId',
    path: (i) => `/conversations/${i.conversationId}`,
    body: () => ({ title: 'Renamed' }),
  },
  {
    method: 'delete',
    route: '/conversations/:conversationId',
    path: (i) => `/conversations/${i.conversationId}`,
  },
  {
    method: 'get',
    route: '/conversations/:conversationId/messages',
    path: (i) => `/conversations/${i.conversationId}/messages`,
  },
  {
    method: 'post',
    route: '/conversations/:conversationId/messages',
    path: (i) => `/conversations/${i.conversationId}/messages`,
    body: () => ({ id: randomUUID(), content: 'Tell me everything' }),
  },
  {
    method: 'post',
    route: '/conversations/:conversationId/retry',
    path: (i) => `/conversations/${i.conversationId}/retry`,
  },
  {
    method: 'put',
    route: '/messages/:messageId/feedback',
    path: (i) => `/messages/${i.messageId}/feedback`,
    body: () => ({ value: 'DOWN' }),
  },
  // Learning paths
  { method: 'get', route: '/learning-paths/:pathId', path: (i) => `/learning-paths/${i.pathId}` },
  {
    method: 'post',
    route: '/learning-paths/:pathId/branch',
    path: (i) => `/learning-paths/${i.pathId}/branch`,
    body: () => ({ branch: 'Vision' }),
  },
  {
    method: 'post',
    route: '/learning-paths/:pathId/retry',
    path: (i) => `/learning-paths/${i.pathId}/retry`,
  },
  {
    method: 'get',
    route: '/learning-paths/:pathId/outline',
    path: (i) => `/learning-paths/${i.pathId}/outline`,
  },
  {
    method: 'patch',
    route: '/modules/:moduleId',
    path: (i) => `/modules/${i.moduleId}`,
    body: () => ({ isEnabled: false }),
  },
  // Lessons
  {
    method: 'get',
    route: '/modules/:moduleId/lesson',
    path: (i) => `/modules/${i.moduleId}/lesson`,
  },
  {
    method: 'post',
    route: '/modules/:moduleId/lessons',
    path: (i) => `/modules/${i.moduleId}/lessons`,
  },
  { method: 'get', route: '/lessons/:lessonId', path: (i) => `/lessons/${i.lessonId}` },
  {
    method: 'put',
    route: '/modules/:moduleId/completion',
    path: (i) => `/modules/${i.moduleId}/completion`,
    body: () => ({ completed: true }),
  },
  // Memories
  {
    method: 'patch',
    route: '/memories/:memoryId',
    path: (i) => `/memories/${i.memoryId}`,
    body: () => ({ content: 'Hates code examples' }),
  },
  { method: 'delete', route: '/memories/:memoryId', path: (i) => `/memories/${i.memoryId}` },
];

/** Routes without an ID: each user only ever sees or changes their own (checked below). */
const unscopedRoutes = [
  'GET /notebooks',
  'POST /notebooks',
  'GET /memories',
  'DELETE /memories',
  'GET /learning-paths/prefill',
  'GET /learning-paths/scope',
  'POST /learning-paths',
];

function call(auth: string, c: Case) {
  const req = request(app)
    [c.method](`/api/v1${c.path(ids)}`)
    .set('authorization', auth);
  return c.body ? req.send(c.body(ids)) : req;
}

const userTables: Table[] = [
  users,
  topics,
  notebooks,
  sources,
  conversations,
  messages,
  learningPaths,
  modules,
  concepts,
  lessons,
  memories,
];

/** Every row of every table (Alice's data plus whatever Bob's first request created). */
async function snapshot() {
  const result: Record<string, unknown[]> = {};
  for (const table of userTables) {
    const rows = (await db
      .select()
      .from(table)
      .orderBy(asc((table as typeof users).id))) as {
      clerkUserId?: string;
    }[];
    // Bob's user row appears on his first request; it's his, not a change to Alice's data.
    result[getTableName(table)] = rows.filter((row) => row.clerkUserId !== 'user_bob');
  }
  return result;
}

beforeEach(async () => {
  await truncateAllTables();
  jobs = createFakeJobs();
  llm = createFakeLlm();
  storage = createFakeStorage();
  app = createTestApp({ jobs, llm, storage });
  ids = await seedAlice();
});

describe('every endpoint as another user → 404', () => {
  it.each(cases)('$method $route', async (c) => {
    const before = await snapshot();

    const res = await call(BOB, c);

    expect(res.status).toBe(404);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
    expect(await snapshot()).toEqual(before);
    expect(jobs.sent).toEqual([]);
    expect(llm.requests).toEqual([]);
    expect(storage.deleted).toEqual([]);

    // The same call as Alice finds it.
    llm.reply('It drops units.');
    const own = await call(ALICE, c);
    expect(own.status).not.toBe(404);
  });
});

describe('references to another user’s resources inside a body', () => {
  async function bobNotebook() {
    const res = await request(app)
      .post('/api/v1/notebooks')
      .set('authorization', BOB)
      .send({ title: 'Bob notes' });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  }

  it('a tutor chat on Alice’s lesson, in Bob’s own notebook → 404, nothing saved', async () => {
    const notebookId = await bobNotebook();
    const before = await db.select().from(conversations);

    const res = await request(app)
      .post(`/api/v1/notebooks/${notebookId}/conversations`)
      .set('authorization', BOB)
      .send({ lessonId: ids.lessonId });

    expect(res.status).toBe(404);
    expect(await db.select().from(conversations)).toEqual(before);
  });

  it('a PDF source from Alice’s upload, in Bob’s own notebook → 400 UPLOAD_NOT_FOUND', async () => {
    const notebookId = await bobNotebook();

    const res = await request(app)
      .post(`/api/v1/notebooks/${notebookId}/sources`)
      .set('authorization', BOB)
      .send({
        type: 'PDF',
        title: 'Stolen',
        storageKey: ids.storageKey,
        contentHash: 'b'.repeat(64),
      });

    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('UPLOAD_NOT_FOUND');
    expect(await db.select().from(sources)).toHaveLength(1);
  });
});

describe('endpoints without an ID only see the caller’s own data', () => {
  it('Bob lists no notebooks and no memories; deleting all of his leaves Alice’s', async () => {
    const list = await request(app).get('/api/v1/notebooks').set('authorization', BOB);
    expect(list.status).toBe(200);
    expect((list.body as { items: unknown[] }).items).toEqual([]);

    const mine = await request(app).get('/api/v1/memories').set('authorization', BOB);
    expect((mine.body as { items: unknown[] }).items).toEqual([]);

    const cleared = await request(app).delete('/api/v1/memories').set('authorization', BOB);
    expect(cleared.status).toBe(204);
    expect(await db.select().from(memories)).toHaveLength(1);
  });

  it('prefill for Alice’s topic doesn’t offer Bob her level', async () => {
    await db.insert(memories).values({
      userId: ids.userId,
      scope: 'TOPIC',
      topicId: ids.topicId,
      kind: 'LEVEL',
      level: 'ADVANCED',
      content: 'Advanced at Deep Learning',
      origin: 'LEVEL_CONFIRMED',
    });

    const prefill = (auth: string) =>
      request(app)
        .get('/api/v1/learning-paths/prefill?topic=Deep%20Learning')
        .set('authorization', auth);

    const res = await prefill(BOB);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('ADVANCED');
    expect(JSON.stringify((await prefill(ALICE)).body)).toContain('ADVANCED');
  });
});

/** Every `METHOD /path` registered under `/api/v1` (sub-routers are mounted without a prefix). */
function registeredRoutes(express: Express): string[] {
  const found: string[] = [];
  interface Layer {
    route?: { path: string; methods: Record<string, boolean> };
    handle?: { stack?: Layer[] };
  }
  const walk = (stack: Layer[] | undefined) => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          found.push(`${method.toUpperCase()} ${layer.route.path}`);
        }
      } else {
        walk(layer.handle?.stack);
      }
    }
  };
  walk((express as unknown as { router: { stack: Layer[] } }).router.stack);
  return found.filter((route) => !route.endsWith('/health'));
}

describe('coverage', () => {
  it('every API route is either in the ownership cases or known to take no ID', () => {
    const covered = [
      ...cases.map((c) => `${c.method.toUpperCase()} ${c.route}`),
      ...unscopedRoutes,
    ].sort();
    expect(registeredRoutes(app).sort()).toEqual(covered);
  });
});
