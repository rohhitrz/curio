import { messageListSchema, notebookSchema, conversationSchema } from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { retrievalFlags, type RetrievalFlags } from '../../src/config/index.js';
import { messages, sourceChunks, sources, users } from '../../src/db/schema/index.js';
import { LlmError } from '../../src/errors/llm-error.js';
import { RerankError } from '../../src/errors/rerank-error.js';
import type { LlmProvider, LlmRequest, LlmResult } from '../../src/lib/llm/index.js';
import type { RerankProvider } from '../../src/lib/rerank/index.js';
import { createFakeEmbeddings, fakeVector, type FakeEmbeddings } from '../fakes/embeddings.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { createFakeLocks, type FakeLocks } from '../fakes/locks.js';
import { createFakeRateLimiter, type FakeRateLimiter } from '../fakes/rate-limit.js';
import { createFakeTracer, type FakeTracer } from '../fakes/tracing.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

/**
 * Phase 10.5: chat through the real endpoint with every retrieval step on (the app's flags plus
 * sub-queries and HyDE), each optional dependency failing on its own and then all at once → a
 * complete, cited answer is still streamed and saved. Only the answer model and both searches
 * failing together are essential (covered in chat.test.ts and retrieval-pipeline.test.ts).
 */

const ALICE = bearer('user_alice');
const db = getTestDb();
const ANSWER = 'Dropout drops units during training [1].';
const QUESTION = 'What is dropout?';

const everyStep: RetrievalFlags = { ...retrievalFlags, subQueries: true, hyde: true };

/** Answers by task; a task in `failing` rejects with a retryable `LlmError`. */
function createRoutedLlm() {
  const failing = new Set<string>();
  const tasks: string[] = [];
  const replyFor = (task: string) => {
    if (task === 'queryUnderstanding') {
      return JSON.stringify({
        needsRetrieval: true,
        standaloneQuery: QUESTION,
        subQueries: ['dropout during training', 'dropout at test time'],
      });
    }
    if (task === 'hyde') return 'Dropout randomly sets units to zero while training.';
    return ANSWER;
  };
  const call = (request: LlmRequest): string | Error => {
    tasks.push(request.task);
    return failing.has(request.task)
      ? new LlmError(true, `${request.task} down`)
      : replyFor(request.task);
  };
  const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 };

  const provider: LlmProvider = {
    generate(request) {
      const reply = call(request);
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ text: reply, model: 'fake-llm', usage });
    },
    generateObject(request, schema) {
      const reply = call(request);
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ object: schema.parse(JSON.parse(reply)), model: 'fake-llm', usage });
    },
    stream(request) {
      const reply = call(request);
      const result: Promise<LlmResult> =
        reply instanceof Error
          ? Promise.reject(reply)
          : Promise.resolve({ text: reply, model: 'fake-llm', usage });
      result.catch(() => undefined);
      async function* textStream(): AsyncGenerator<string> {
        await Promise.resolve();
        if (reply instanceof Error) throw reply;
        yield* reply.match(/.{1,8}/gs) ?? [];
      }
      return { textStream: textStream(), result };
    },
  };
  return { provider, failing, tasks };
}

/** Scores every passage as relevant (above the gate), or fails when `down`. */
function createReranker() {
  const state = { down: false, calls: 0 };
  const provider: RerankProvider = {
    model: 'fake-rerank',
    rerank(request) {
      state.calls += 1;
      if (state.down) return Promise.reject(new RerankError(true, 'Cohere 503'));
      return Promise.resolve({
        results: request.documents.map((_, index) => ({ index, score: 0.9 - index * 0.01 })),
        model: 'fake-rerank',
        searchUnits: 1,
      });
    },
  };
  return { provider, state };
}

let llm: ReturnType<typeof createRoutedLlm>;
let reranker: ReturnType<typeof createReranker>;
let embeddings: FakeEmbeddings;
let jobs: FakeJobs;
let tracer: FakeTracer;
let locks: FakeLocks;
let limiter: FakeRateLimiter;
let app: ReturnType<typeof createTestApp>;

beforeEach(async () => {
  await truncateAllTables();
  llm = createRoutedLlm();
  reranker = createReranker();
  embeddings = createFakeEmbeddings();
  jobs = createFakeJobs();
  tracer = createFakeTracer();
  locks = createFakeLocks();
  limiter = createFakeRateLimiter();
  app = createTestApp({
    llm: { provider: llm.provider, requests: [], reply: () => 0 },
    reranker: reranker.provider,
    embeddings,
    jobs,
    tracer,
    locks,
    rateLimiter: limiter,
    flags: everyStep,
  });
});

/** A notebook with one READY source about dropout, and a chat with `earlier` messages in it. */
async function setup(earlier = 0) {
  const notebook = await request(app)
    .post('/api/v1/notebooks')
    .set('authorization', ALICE)
    .send({ title: 'ML' });
  const notebookId = notebookSchema.parse(notebook.body).id;
  const [user] = await db.select().from(users).where(eq(users.clerkUserId, 'user_alice'));
  if (!user) throw new Error('alice missing');
  const [source] = await db
    .insert(sources)
    .values({
      notebookId,
      userId: user.id,
      type: 'TEXT',
      title: 'ML Notes',
      status: 'READY',
      contentHash: crypto.randomUUID(),
      chunkCount: 1,
    })
    .returning();
  if (!source) throw new Error('source not created');
  const content = 'Dropout randomly drops units during training to reduce overfitting.';
  await db.insert(sourceChunks).values({
    sourceId: source.id,
    notebookId,
    chunkIndex: 0,
    content,
    contextHeader: 'ML Notes',
    embedding: fakeVector(content),
    tokenCount: 10,
  });
  const conversation = await request(app)
    .post(`/api/v1/notebooks/${notebookId}/conversations`)
    .set('authorization', ALICE)
    .send({});
  const conversationId = conversationSchema.parse(conversation.body).id;
  for (let seq = 1; seq <= earlier; seq++) {
    await db.insert(messages).values({
      conversationId,
      seq,
      role: seq % 2 === 1 ? 'USER' : 'ASSISTANT',
      content: seq % 2 === 1 ? `Question ${String(seq)}?` : `Answer ${String(seq)}.`,
    });
  }
  return { conversationId, sourceId: source.id };
}

/** Sends the question; returns the streamed text and the saved answer. */
async function ask(conversationId: string) {
  const res = await request(app)
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set('authorization', ALICE)
    .send({ id: crypto.randomUUID(), content: QUESTION });
  expect(res.status).toBe(200);
  const parts = res.text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; delta?: string });
  const list = await request(app)
    .get(`/api/v1/conversations/${conversationId}/messages`)
    .set('authorization', ALICE);
  const saved = messageListSchema
    .parse(list.body)
    .items.reduce((last, m) => (m.seq > last.seq ? m : last));
  return {
    streamed: parts
      .filter((p) => p.type === 'text-delta')
      .map((p) => p.delta)
      .join(''),
    errored: parts.some((p) => p.type === 'error'),
    saved,
  };
}

async function expectFullAnswer(conversationId: string, sourceId: string) {
  const { streamed, errored, saved } = await ask(conversationId);
  expect(errored).toBe(false);
  expect(streamed).toBe(ANSWER);
  expect(saved).toMatchObject({ role: 'ASSISTANT', status: 'COMPLETE', content: ANSWER });
  expect(saved.citations).toEqual([expect.objectContaining({ marker: 1, sourceId })]);
}

/** The steps the trace reports as failed (and skipped). */
const failedSteps = () =>
  (tracer.spans.find((s) => s.name === 'retrieve')?.output as { failed?: string[] } | undefined)
    ?.failed ?? [];

describe('chat with every retrieval step on', () => {
  it('nothing failing: every optional step runs (so the cases below really remove one)', async () => {
    const { conversationId, sourceId } = await setup();
    await expectFullAnswer(conversationId, sourceId);
    expect(new Set(llm.tasks)).toEqual(new Set(['queryUnderstanding', 'hyde', 'chatAnswer']));
    // The whole question and its two sub-queries, each reranked (R-11).
    expect(reranker.state.calls).toBe(3);
    expect(failedSteps()).toEqual([]);
  });

  it('query understanding down → the raw question is searched', async () => {
    llm.failing.add('queryUnderstanding');
    const { conversationId, sourceId } = await setup();
    await expectFullAnswer(conversationId, sourceId);
    expect(failedSteps()).toContain('understand');
  });

  it('HyDE down → searched without the hypothetical passage', async () => {
    llm.failing.add('hyde');
    const { conversationId, sourceId } = await setup();
    await expectFullAnswer(conversationId, sourceId);
    expect(failedSteps()).toContain('hyde');
  });

  it('rerank down → the fused order is kept and the gate skipped', async () => {
    reranker.state.down = true;
    const { conversationId, sourceId } = await setup();
    await expectFullAnswer(conversationId, sourceId);
    expect(failedSteps()).toContain('rerank');
  });

  it('embeddings down (vector search) → keyword search alone finds the source', async () => {
    const { conversationId, sourceId } = await setup();
    embeddings.failNext(...Array.from({ length: 10 }, () => new Error('OpenAI embeddings 503')));
    await expectFullAnswer(conversationId, sourceId);
    expect(failedSteps()).toContain('vectorSearch');
  });

  it('background job queue down → answer saved; the memory job is only logged', async () => {
    const control = await setup(8);
    await expectFullAnswer(control.conversationId, control.sourceId);
    // With 8 earlier messages the answer queues memory extraction…
    expect(jobs.sent.map((e) => e.name)).toContain('memory/extract');

    // …so here that send is the one that fails.
    jobs.sent.length = 0;
    const { conversationId, sourceId } = await setup(8);
    jobs.failNextSend(new Error('Inngest unreachable'));
    await expectFullAnswer(conversationId, sourceId);
    expect(jobs.sent.map((e) => e.name)).not.toContain('memory/extract');
  });

  it('tracing unreachable → answer saved', async () => {
    tracer.failFlushes();
    const { conversationId, sourceId } = await setup();
    await expectFullAnswer(conversationId, sourceId);
  });

  it('lock release failing (Redis gone after the start) → answer saved; the lock expires', async () => {
    locks.failHeldCalls();
    const { conversationId, sourceId } = await setup();
    await expectFullAnswer(conversationId, sourceId);
  });

  it('rate-limit service down → the request goes through', async () => {
    limiter.failNextCheck(new Error('Upstash unreachable'));
    const { conversationId, sourceId } = await setup();
    await expectFullAnswer(conversationId, sourceId);
  });

  it('every optional dependency down at once → still a full, cited answer', async () => {
    llm.failing.add('queryUnderstanding').add('hyde');
    reranker.state.down = true;
    tracer.failFlushes();
    locks.failHeldCalls();
    limiter.failNextCheck(new Error('Upstash unreachable'));
    const { conversationId, sourceId } = await setup(8);
    jobs.failNextSend(new Error('Inngest unreachable'));
    embeddings.failNext(...Array.from({ length: 10 }, () => new Error('OpenAI embeddings 503')));

    await expectFullAnswer(conversationId, sourceId);
    expect(failedSteps()).toEqual(expect.arrayContaining(['understand', 'hyde', 'rerank']));
  });
});
