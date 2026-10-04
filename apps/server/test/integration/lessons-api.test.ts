import { conversationSchema, errorResponseSchema, lessonSchema, moduleSchema } from '@curio/shared';
import { and, eq } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  concepts,
  learningPaths,
  lessons,
  memories,
  messages,
  modules,
  notebooks,
  sourceChunks,
  sources,
  topics,
  users,
} from '../../src/db/schema/index.js';
import { LlmError } from '../../src/errors/llm-error.js';
import type { LlmProvider, LlmResult } from '../../src/lib/llm/index.js';
import type { RerankProvider } from '../../src/lib/rerank/index.js';
import { GENERAL_KNOWLEDGE_NOTE, LESSON_INSTRUCTIONS } from '../../src/pipelines/lessons/prompt.js';
import { DONE_MARKER } from '../../src/pipelines/tutor/marker.js';
import { TUTOR_INSTRUCTIONS } from '../../src/pipelines/tutor/prompt.js';
import { createFakeEmbeddings, fakeVector } from '../fakes/embeddings.js';
import { createFakeLlm, type FakeLlm } from '../fakes/llm.js';
import { createFakeLocks, type FakeLocks } from '../fakes/locks.js';
import { createFakeRateLimiter, type FakeRateLimiter } from '../fakes/rate-limit.js';
import { createFakeTracer, type FakeTracer } from '../fakes/tracing.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const db = getTestDb();
const errorCode = (body: unknown) => errorResponseSchema.parse(body).error.code;

const DROPOUT = 'Dropout randomly drops units during training to reduce overfitting.';

/** Documents the reranker was asked about, per call (what a search found). */
let reranked: string[][] = [];
/** Relevant only for dropout: the gate refuses anything else (general knowledge). */
const reranker: RerankProvider = {
  model: 'fake-rerank',
  rerank: ({ query, documents }) => {
    reranked.push(documents);
    return Promise.resolve({
      results: [{ index: 0, score: query.toLowerCase().includes('dropout') ? 0.95 : 0.05 }],
      model: 'fake-rerank',
      searchUnits: 1,
    });
  },
};

const LESSON_TEXT = [
  'This module covers how networks avoid overfitting.',
  '',
  '## Dropout',
  'Dropout drops units while training [1]. It never runs at inference [7].',
  '',
  '## Activation functions',
  `> ${GENERAL_KNOWLEDGE_NOTE}`,
  'They add non-linearity.',
  '',
  '## Key takeaways',
  '- Dropout fights overfitting [1].',
].join('\n');

let llm: FakeLlm;
let locks: FakeLocks;
let limiter: FakeRateLimiter;
let tracer: FakeTracer;
let app: ReturnType<typeof createTestApp>;
let ids: {
  userId: string;
  pathId: string;
  notebookId: string;
  m1: string;
  m2: string;
  sourceId: string;
};

function buildApp(provider?: LlmProvider) {
  reranked = [];
  llm = createFakeLlm();
  locks = createFakeLocks();
  limiter = createFakeRateLimiter();
  tracer = createFakeTracer();
  app = createTestApp({
    llm: provider ? { ...llm, provider } : llm,
    locks,
    rateLimiter: limiter,
    tracer,
    embeddings: createFakeEmbeddings(),
    flags: { hybridSearch: true, rerank: true, relevanceGate: true },
    reranker,
  });
}

/**
 * Alice's READY intermediate path: module 1 teaches Dropout (in the source) and Activation
 * functions (not in it), module 2 is turned off; one skipped concept.
 */
async function seed() {
  const [user] = await db.insert(users).values({ clerkUserId: 'user_alice' }).returning();
  const [topic] = await db
    .insert(topics)
    .values({ name: 'Deep Learning', normalizedName: 'deep learning', embedding: fakeVector('dl') })
    .returning();
  if (!user || !topic) throw new Error('seed failed');
  const [notebook] = await db
    .insert(notebooks)
    .values({ userId: user.id, title: 'Deep Learning', kind: 'LEARNING', topicId: topic.id })
    .returning();
  if (!notebook) throw new Error('seed failed');
  const [path] = await db
    .insert(learningPaths)
    .values({
      notebookId: notebook.id,
      userId: user.id,
      topic: 'Deep Learning',
      level: 'INTERMEDIATE',
      goal: 'JOB',
      status: 'READY',
    })
    .returning();
  if (!path) throw new Error('seed failed');
  const [m1, m2] = await db
    .insert(modules)
    .values([
      {
        pathId: path.id,
        position: 1,
        title: 'Regularization',
        summary: 'Keeping models general',
        why: 'Real data is noisy',
      },
      { pathId: path.id, position: 2, title: 'Optimizers', summary: 'Training', isEnabled: false },
    ])
    .returning();
  if (!m1 || !m2) throw new Error('seed failed');
  await db.insert(concepts).values([
    {
      pathId: path.id,
      name: 'Activation functions',
      description: 'Non-linear functions on each unit',
      consensusScore: 0.2,
      status: 'INCLUDED',
      moduleId: m1.id,
      position: 2,
    },
    {
      pathId: path.id,
      name: 'Dropout',
      description: 'Dropping units while training',
      consensusScore: 1,
      status: 'INCLUDED',
      moduleId: m1.id,
      position: 1,
    },
    {
      pathId: path.id,
      name: 'Kernels',
      description: 'd',
      consensusScore: 0.1,
      status: 'SKIPPED',
      skipReason: 'r',
    },
  ]);
  const [source] = await db
    .insert(sources)
    .values({
      notebookId: notebook.id,
      userId: user.id,
      type: 'PDF',
      origin: 'LEARNING_PATH',
      title: 'DL Book',
      status: 'READY',
      contentHash: 'hash-book',
      chunkCount: 1,
    })
    .returning();
  if (!source) throw new Error('seed failed');
  await db.insert(sourceChunks).values({
    sourceId: source.id,
    notebookId: notebook.id,
    chunkIndex: 0,
    content: DROPOUT,
    contextHeader: 'DL Book',
    embedding: fakeVector(DROPOUT),
    tokenCount: 12,
    pageNumber: 4,
  });
  ids = {
    userId: user.id,
    pathId: path.id,
    notebookId: notebook.id,
    m1: m1.id,
    m2: m2.id,
    sourceId: source.id,
  };
}

beforeEach(async () => {
  await truncateAllTables();
  buildApp();
  await seed();
});

type StreamChunk = { type: string } & Record<string, unknown>;
const parseStream = (body: string): StreamChunk[] =>
  body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as StreamChunk);
const textOf = (chunks: StreamChunk[]) =>
  chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.delta as string)
    .join('');

const get = (path: string, auth = ALICE) =>
  request(app).get(`/api/v1${path}`).set('authorization', auth);
const generate = (moduleId: string, auth = ALICE) =>
  request(app).post(`/api/v1/modules/${moduleId}/lessons`).set('authorization', auth).send({});
const complete = (moduleId: string, completed: boolean, auth = ALICE) =>
  request(app)
    .put(`/api/v1/modules/${moduleId}/completion`)
    .set('authorization', auth)
    .send({ completed });

describe('GET /modules/:moduleId/lesson', () => {
  it('before generation → 404 LESSON_NOT_GENERATED; unknown or not yours → 404 NOT_FOUND', async () => {
    const res = await get(`/modules/${ids.m1}/lesson`);
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe('LESSON_NOT_GENERATED');

    expect(errorCode((await get(`/modules/${ids.m1}/lesson`, BOB)).body)).toBe('NOT_FOUND');
    expect(errorCode((await get(`/modules/${crypto.randomUUID()}/lesson`)).body)).toBe('NOT_FOUND');
  });
});

describe('POST /modules/:moduleId/lessons', () => {
  it('streams the lesson with citations and saves it as version 1', async () => {
    llm.reply(LESSON_TEXT);

    const res = await generate(ids.m1);

    expect(res.status).toBe(200);
    const chunks = parseStream(res.text);
    const lessonId = chunks.find((c) => c.type === 'start')?.messageId;
    expect(
      chunks
        .filter((c) => c.type === 'data-status')
        .map((c) => (c.data as { message: string }).message),
    ).toEqual(['Studying your resources…', 'Writing the lesson…']);
    expect(textOf(chunks)).toBe(LESSON_TEXT);
    const streamed = chunks.find((c) => c.type === 'data-citations')?.data as unknown[];
    expect(streamed).toHaveLength(1);

    // The model saw the module, the concepts in order and which are general knowledge.
    const sent = llm.requests[0];
    expect(sent).toMatchObject({ task: 'lesson', instructions: LESSON_INSTRUCTIONS });
    const message = sent?.messages.at(-1)?.content ?? '';
    expect(message).toContain('Module: Regularization');
    expect(message).toContain('Why it matters: Real data is noisy');
    expect(message).toContain('Module before it: None (this is the first module).');
    expect(message).toMatch(/1\. Dropout: .*\n {3}→ passages \[1\]/);
    expect(message).toMatch(/2\. Activation functions: .*\n {3}→ GENERAL KNOWLEDGE/);
    expect(message).toContain(`[1] DL Book (page 4)\n${DROPOUT}`);
    expect(message).not.toContain('Kernels');

    const lesson = lessonSchema.parse((await get(`/modules/${ids.m1}/lesson`)).body);
    expect(lesson).toMatchObject({
      id: lessonId,
      moduleId: ids.m1,
      version: 1,
      status: 'COMPLETE',
      model: 'fake-llm',
      conversationId: null,
    });
    // The invented [7] is gone from the saved lesson.
    expect(lesson.content).toContain('It never runs at inference.');
    expect(lesson.content).not.toContain('[7]');
    expect(lesson.citations).toEqual([
      expect.objectContaining({ marker: 1, sourceTitle: 'DL Book', pageNumber: 4 }),
    ]);
    expect(tracer.traces[0]?.output).toMatchObject({ generalKnowledge: ['Activation functions'] });
  });

  it('regenerate → version 2; version 1 still readable', async () => {
    llm.reply(LESSON_TEXT, 'Second take [1].');
    await generate(ids.m1);
    const first = lessonSchema.parse((await get(`/modules/${ids.m1}/lesson`)).body);

    await generate(ids.m1);

    const latest = lessonSchema.parse((await get(`/modules/${ids.m1}/lesson`)).body);
    expect(latest).toMatchObject({ version: 2, content: 'Second take [1].' });
    const old = await get(`/lessons/${first.id}`);
    expect(old.status).toBe(200);
    expect(lessonSchema.parse(old.body)).toMatchObject({ version: 1, content: first.content });
    expect((await get(`/lessons/${first.id}`, BOB)).status).toBe(404);
  });

  it('while generating → 409 LESSON_GENERATING; the lock is released after', async () => {
    const held = await locks.provider.acquire(`lesson:${ids.m1}`, 120);

    const busy = await generate(ids.m1);
    expect(busy.status).toBe(409);
    expect(errorCode(busy.body)).toBe('LESSON_GENERATING');

    await held?.release();
    llm.reply(LESSON_TEXT);
    expect((await generate(ids.m1)).status).toBe(200);
    expect(await locks.provider.acquire(`lesson:${ids.m1}`, 120)).not.toBeNull();
  });

  it('disabled module → 409 MODULE_DISABLED; path not READY → 409 PATH_NOT_READY; not yours → 404', async () => {
    expect(errorCode((await generate(ids.m2)).body)).toBe('MODULE_DISABLED');
    expect((await generate(ids.m1, BOB)).status).toBe(404);
    await db
      .update(learningPaths)
      .set({ status: 'BUILDING' })
      .where(eq(learningPaths.id, ids.pathId));
    const res = await generate(ids.m1);
    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe('PATH_NOT_READY');
    expect(llm.requests).toEqual([]);
  });

  it('the model failing → error event, saved as ERROR; the module still has no lesson', async () => {
    llm.reply(new LlmError(true, 'down'));

    const chunks = parseStream((await generate(ids.m1)).text);

    expect(chunks.find((c) => c.type === 'data-error')?.data).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    const saved = await db.select().from(lessons);
    expect(saved).toEqual([expect.objectContaining({ status: 'ERROR', version: 1 })]);
    expect(errorCode((await get(`/modules/${ids.m1}/lesson`)).body)).toBe('LESSON_NOT_GENERATED');
  });

  it('over the daily limit → 429', async () => {
    limiter.denyAll(60);
    const res = await generate(ids.m1);
    expect(res.status).toBe(429);
    expect(limiter.checks).toEqual([expect.objectContaining({ name: 'lessonGenerations' })]);
  });

  it('the client disconnecting mid-stream still completes and saves the lesson', async () => {
    let releaseRest!: () => void;
    const rest = new Promise<void>((resolve) => {
      releaseRest = resolve;
    });
    const slowLlm: LlmProvider = {
      generate: () => Promise.reject(new Error('not used')),
      generateObject: () => Promise.reject(new Error('not used')),
      stream() {
        let resolve!: (result: LlmResult) => void;
        const result = new Promise<LlmResult>((res) => {
          resolve = res;
        });
        async function* textStream() {
          yield 'Dropout ';
          await rest;
          yield 'drops units [1].';
          resolve({
            text: 'Dropout drops units [1].',
            model: 'fake-llm',
            usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
          });
        }
        return { textStream: textStream(), result };
      },
    };
    buildApp(slowLlm);
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/modules/${ids.m1}/lessons`, {
        method: 'POST',
        headers: { authorization: ALICE },
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      let received = '';
      while (!received.includes('Dropout ')) {
        const part = await reader?.read();
        if (!part || part.done) break;
        received += new TextDecoder().decode(part.value as Uint8Array);
      }
      controller.abort();
      releaseRest();

      let saved;
      for (let attempt = 0; attempt < 50 && !saved; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        [saved] = await db.select().from(lessons);
      }
      expect(saved).toMatchObject({ status: 'COMPLETE', content: 'Dropout drops units [1].' });
    } finally {
      server.close();
    }
  });
});

describe('PUT /modules/:moduleId/completion', () => {
  const understood = () =>
    db
      .select({ content: memories.content, originRef: memories.originRef, origin: memories.origin })
      .from(memories)
      .where(and(eq(memories.userId, ids.userId), eq(memories.kind, 'UNDERSTOOD')));

  it('done → completed_at + an UNDERSTOOD memory per taught concept; again → no duplicates', async () => {
    const res = await complete(ids.m1, true);

    expect(res.status).toBe(200);
    expect(moduleSchema.parse(res.body).completedAt).not.toBeNull();
    const first = await understood();
    expect(first.map((m) => m.content).sort()).toEqual(['Activation functions', 'Dropout']);
    expect(first.every((m) => m.originRef === ids.m1 && m.origin === 'LESSON_COMPLETED')).toBe(
      true,
    );

    await complete(ids.m1, true);
    expect(await understood()).toHaveLength(2);
  });

  it('un-marking clears completed_at and removes those memories, keeping an edited one', async () => {
    await complete(ids.m1, true);
    await db
      .update(memories)
      .set({ origin: 'USER_EDITED', content: 'Dropout, and why it helps' })
      .where(eq(memories.content, 'Dropout'));

    const res = await complete(ids.m1, false);

    expect(moduleSchema.parse(res.body).completedAt).toBeNull();
    expect((await understood()).map((m) => m.content)).toEqual(['Dropout, and why it helps']);
  });

  it('invalid body → 400; not yours or unknown → 404', async () => {
    expect(
      (
        await request(app)
          .put(`/api/v1/modules/${ids.m1}/completion`)
          .set('authorization', ALICE)
          .send({})
      ).status,
    ).toBe(400);
    expect((await complete(ids.m1, true, BOB)).status).toBe(404);
    expect((await complete(crypto.randomUUID(), true)).status).toBe(404);
    expect(await understood()).toEqual([]);
  });
});

describe("tutor (a lesson's chat)", () => {
  const OTHER = 'Weight decay is not dropout: it shrinks weights.';

  /** A saved lesson citing the book, plus a second notebook source the lesson doesn't cite. */
  async function seedLesson() {
    const [lesson] = await db
      .insert(lessons)
      .values({
        moduleId: ids.m1,
        version: 1,
        content: 'Dropout drops units while training [1].',
        citations: [
          {
            marker: 1,
            sourceId: ids.sourceId,
            sourceTitle: 'DL Book',
            sourceType: 'PDF',
            snippet: DROPOUT,
            pageNumber: 4,
            startSeconds: null,
            headingPath: null,
            charStart: null,
            charEnd: null,
          },
        ],
        status: 'COMPLETE',
        model: 'fake-llm',
      })
      .returning();
    const [other] = await db
      .insert(sources)
      .values({
        notebookId: ids.notebookId,
        userId: ids.userId,
        type: 'PDF',
        title: 'Other notes',
        status: 'READY',
        contentHash: 'hash-other',
        chunkCount: 1,
      })
      .returning();
    if (!lesson || !other) throw new Error('seed failed');
    await db.insert(sourceChunks).values({
      sourceId: other.id,
      notebookId: ids.notebookId,
      chunkIndex: 0,
      content: OTHER,
      contextHeader: 'Other notes',
      embedding: fakeVector(OTHER),
      tokenCount: 10,
    });
    return lesson.id;
  }

  const startTutor = (lessonId: string, notebookId = ids.notebookId, auth = ALICE) =>
    request(app)
      .post(`/api/v1/notebooks/${notebookId}/conversations`)
      .set('authorization', auth)
      .send({ lessonId });
  const ask = (conversationId: string, content: string) =>
    request(app)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('authorization', ALICE)
      .send({ id: crypto.randomUUID(), content });

  it('a lesson from another notebook or user → 404; its own notebook → 201, found from the lesson', async () => {
    const lessonId = await seedLesson();
    const [elsewhere] = await db
      .insert(notebooks)
      .values({ userId: ids.userId, title: 'Other', kind: 'SOURCE' })
      .returning();

    expect((await startTutor(lessonId, elsewhere?.id ?? '')).status).toBe(404);
    expect((await startTutor(crypto.randomUUID())).status).toBe(404);
    const res = await startTutor(lessonId);
    expect(res.status).toBe(201);
    const conversation = conversationSchema.parse(res.body);
    expect(conversation.lessonId).toBe(lessonId);

    const lesson = lessonSchema.parse((await get(`/modules/${ids.m1}/lesson`)).body);
    expect(lesson.conversationId).toBe(conversation.id);
  });

  it("searches only the lesson's cited sources and knows the lesson, module and path", async () => {
    const lessonId = await seedLesson();
    const conversation = conversationSchema.parse((await startTutor(lessonId)).body);
    llm.reply('It stops units relying on each other [1].');

    const chunks = parseStream((await ask(conversation.id, 'Why does dropout help?')).text);

    expect(textOf(chunks)).toBe('It stops units relying on each other [1].');
    const seen = reranked.flat().join('\n');
    expect(seen).toContain(DROPOUT);
    expect(seen).not.toContain(OTHER);
    const sent = llm.requests[0];
    expect(sent?.instructions).toBe(TUTOR_INSTRUCTIONS);
    const message = sent?.messages.at(-1)?.content ?? '';
    expect(message).toContain('Module: Regularization');
    expect(message).toContain('1. Regularization: Keeping models general ← this module');
    // The turned-off module isn't part of the path the tutor sees.
    expect(message).not.toContain('Optimizers');
    expect(message).toContain('Dropout drops units while training.\n');
    expect(message).toContain('Question: Why does dropout help?');
    expect(chunks.some((c) => c.type === 'data-action')).toBe(false);
  });

  it('nothing in the sources still asks the model (the lesson may answer it)', async () => {
    const lessonId = await seedLesson();
    const conversation = conversationSchema.parse((await startTutor(lessonId)).body);
    llm.reply("Your resources don't cover that.");

    await ask(conversation.id, 'What about batch norm?');

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.messages.at(-1)?.content).toContain(
      '(nothing in the resources matched this question)',
    );
  });

  it('a final "ready" marker → action event, never shown or saved; nothing marked done', async () => {
    const lessonId = await seedLesson();
    const conversation = conversationSchema.parse((await startTutor(lessonId)).body);
    llm.reply(`You've got it: dropout fights overfitting [1].\n${DONE_MARKER}`);

    const chunks = parseStream(
      (await ask(conversation.id, 'Got it, dropout makes sense now!')).text,
    );

    expect(textOf(chunks)).not.toContain(DONE_MARKER);
    expect(chunks.find((c) => c.type === 'data-action')?.data).toEqual({
      type: 'SUGGEST_COMPLETE',
      moduleId: ids.m1,
    });
    const [answer] = await db.select().from(messages).where(eq(messages.role, 'ASSISTANT'));
    expect(answer?.content).toBe("You've got it: dropout fights overfitting [1].");
    const [module] = await db.select().from(modules).where(eq(modules.id, ids.m1));
    expect(module?.completedAt).toBeNull();
  });
});
