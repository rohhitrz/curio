import { InngestTestEngine } from '@inngest/test';
import { conversationSchema, notebookSchema } from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { memoryExtraction, quotas } from '../../src/config/index.js';
import { conversations, memories, messages, users } from '../../src/db/schema/index.js';
import { createExtractMemoriesFunction } from '../../src/inngest/extract-memories.js';
import { createInngestClient } from '../../src/lib/jobs/index.js';
import {
  MEMORY_EXTRACTION_INSTRUCTIONS,
  type ExtractionOperation,
} from '../../src/pipelines/memory/extract.js';
import { createChatRepository } from '../../src/repositories/chat.repository.js';
import { createMemoriesRepository } from '../../src/repositories/memories.repository.js';
import { createNotebooksRepository } from '../../src/repositories/notebooks.repository.js';
import {
  createMemoryExtractionService,
  type MemoryExtractionService,
} from '../../src/services/memory-extraction.service.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { createFakeLlm, type FakeLlm } from '../fakes/llm.js';
import { createFakeTracer, type FakeTracer } from '../fakes/tracing.js';
import { bearer, createTestApp, testLogger } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const db = getTestDb();
const memoriesRepository = createMemoriesRepository(db);
const MESSAGES = memoryExtraction.afterMessages + 2;

let llm: FakeLlm;
let tracer: FakeTracer;
let jobs: FakeJobs;
let app: ReturnType<typeof createTestApp>;
let service: MemoryExtractionService;

beforeEach(async () => {
  await truncateAllTables();
  llm = createFakeLlm();
  tracer = createFakeTracer();
  jobs = createFakeJobs();
  app = createTestApp({ llm, tracer, jobs });
  service = createMemoryExtractionService({
    chat: createChatRepository(db),
    memories: memoriesRepository,
    notebooks: createNotebooksRepository(db),
    llm: llm.provider,
    tracer: tracer.tracer,
    logger: testLogger,
  });
});

async function userIdOf(clerkUserId: string): Promise<string> {
  const [user] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
  if (!user) throw new Error(`no user ${clerkUserId}`);
  return user.id;
}

/** A conversation in a notebook with `topic` (none if null). */
async function createConversation(topic: string | null = 'Statistics', auth = ALICE) {
  const notebook = await request(app)
    .post('/api/v1/notebooks')
    .set('authorization', auth)
    .send({ title: 'Notes' });
  const notebookId = notebookSchema.parse(notebook.body).id;
  if (topic) {
    await request(app)
      .patch(`/api/v1/notebooks/${notebookId}`)
      .set('authorization', auth)
      .send({ topic });
  }
  const res = await request(app)
    .post(`/api/v1/notebooks/${notebookId}/conversations`)
    .set('authorization', auth)
    .send({});
  return conversationSchema.parse(res.body).id;
}

const ANSWER =
  'The standard deviation measures how far the values of a data set typically lie from their mean.';

/** Messages 1..count: the learner's lines (cycled) and a fixed answer. */
async function seedMessages(conversationId: string, count = MESSAGES, lines = ['Hi']) {
  await db.insert(messages).values(
    Array.from({ length: count }, (_, i) => {
      const seq = i + 1;
      const isUser = seq % 2 === 1;
      return {
        conversationId,
        seq,
        role: isUser ? ('USER' as const) : ('ASSISTANT' as const),
        content: isUser ? (lines[i / 2] ?? lines[0] ?? 'Hi') : ANSWER,
      };
    }),
  );
}

const reply = (...operations: ExtractionOperation[]) => {
  llm.reply(JSON.stringify({ operations }));
};

const addOp = (content: string, overrides: Partial<ExtractionOperation> = {}) => ({
  action: 'add' as const,
  memoryId: null,
  kind: 'FACT' as const,
  scope: 'GLOBAL' as const,
  content,
  ...overrides,
});

async function run(ref: { conversationId: string; userId: string }) {
  const draft = await service.draft(ref);
  if (draft.status !== 'drafted') return draft;
  return service.apply(ref, draft);
}

async function aliceRef(conversationId: string) {
  return { conversationId, userId: await userIdOf('user_alice') };
}

async function marker(conversationId: string) {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  return row?.memoryExtractedThroughSeq;
}

describe('memory extraction job', () => {
  it('a new fact → memory with CHAT_EXTRACTED; topic facts get the notebook topic', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId, MESSAGES, ['I am a nurse, please keep it simple']);
    const ref = await aliceRef(conversationId);
    reply(addOp('Is a nurse.'), addOp('Is new to statistics.', { scope: 'TOPIC' }));

    const result = await run(ref);

    expect(result).toEqual({ status: 'applied', added: 2, updated: 0, throughSeq: MESSAGES });
    const rows = await memoriesRepository.list(ref.userId);
    expect(rows.map((m) => [m.content, m.scope, m.topicName, m.origin, m.originRef])).toEqual(
      expect.arrayContaining([
        ['Is a nurse.', 'GLOBAL', null, 'CHAT_EXTRACTED', conversationId],
        ['Is new to statistics.', 'TOPIC', 'Statistics', 'CHAT_EXTRACTED', conversationId],
      ]),
    );
    expect(await marker(conversationId)).toBe(MESSAGES);
    expect(llm.requests[0]?.instructions).toBe(MEMORY_EXTRACTION_INSTRUCTIONS);
    expect(llm.requests[0]?.task).toBe('memoryExtraction');
    expect(tracer.traces.map((t) => t.name)).toEqual(['memory-extraction']);
  });

  it('a contradicting fact updates the existing memory, no duplicate', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId);
    const ref = await aliceRef(conversationId);
    const existing = await memoriesRepository.insertWithinCap(
      ref.userId,
      { topicId: null, kind: 'STYLE', content: 'Prefers short answers.', origin: 'CHAT_EXTRACTED' },
      quotas.memoriesPerUser,
    );
    if (!existing) throw new Error('not created');
    reply({
      action: 'update',
      memoryId: existing.id,
      kind: null,
      scope: null,
      content: 'Prefers detailed answers.',
    });

    const result = await run(ref);

    expect(result).toMatchObject({ status: 'applied', added: 0, updated: 1 });
    const rows = await memoriesRepository.list(ref.userId);
    expect(rows.map((m) => m.content)).toEqual(['Prefers detailed answers.']);
    // The model saw the memory with its id.
    expect(llm.requests[0]?.messages[0]?.content).toContain(`id ${existing.id}`);
  });

  it('a user-edited memory is never overwritten', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId);
    const ref = await aliceRef(conversationId);
    const edited = await memoriesRepository.insertWithinCap(
      ref.userId,
      { topicId: null, kind: 'STYLE', content: 'Likes diagrams.', origin: 'USER_EDITED' },
      quotas.memoriesPerUser,
    );
    if (!edited) throw new Error('not created');
    reply({
      action: 'update',
      memoryId: edited.id,
      kind: null,
      scope: null,
      content: 'Hates diagrams.',
    });

    await run(ref);

    expect((await memoriesRepository.findById(ref.userId, edited.id))?.content).toBe(
      'Likes diagrams.',
    );
    expect(llm.requests[0]?.messages[0]?.content).toContain('set by the learner');
  });

  it('a user edit between draft and apply still wins', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId);
    const ref = await aliceRef(conversationId);
    const memory = await memoriesRepository.insertWithinCap(
      ref.userId,
      { topicId: null, kind: 'STYLE', content: 'Likes lists.', origin: 'CHAT_EXTRACTED' },
      quotas.memoriesPerUser,
    );
    if (!memory) throw new Error('not created');
    reply({
      action: 'update',
      memoryId: memory.id,
      kind: null,
      scope: null,
      content: 'Likes tables.',
    });

    const draft = await service.draft(ref);
    if (draft.status !== 'drafted') throw new Error('not drafted');
    await memoriesRepository.update(ref.userId, memory.id, {
      content: 'Likes numbered lists.',
      origin: 'USER_EDITED',
    });
    const result = await service.apply(ref, draft);

    expect(result).toMatchObject({ status: 'applied', updated: 0 });
    expect((await memoriesRepository.findById(ref.userId, memory.id))?.content).toBe(
      'Likes numbered lists.',
    );
  });

  it('source content in the output is rejected by the job', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId);
    const ref = await aliceRef(conversationId);
    reply(
      addOp('The standard deviation measures how far the values of a data set typically lie.'),
      addOp('Is preparing for an exam.', { kind: 'GOAL' }),
    );

    const result = await run(ref);

    expect(result).toMatchObject({ status: 'applied', added: 1 });
    expect((await memoriesRepository.list(ref.userId)).map((m) => m.content)).toEqual([
      'Is preparing for an exam.',
    ]);
  });

  it('memory cap reached: no new memories beyond it', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId);
    const ref = await aliceRef(conversationId);
    await db.insert(memories).values(
      Array.from({ length: quotas.memoriesPerUser }, (_, i) => ({
        userId: ref.userId,
        scope: 'GLOBAL' as const,
        kind: 'FACT' as const,
        content: `Old ${i}`,
        origin: 'CHAT_EXTRACTED' as const,
      })),
    );
    reply(addOp('Is a nurse.'));

    const result = await run(ref);

    expect(result).toMatchObject({ status: 'applied', added: 0 });
    expect(await memoriesRepository.count(ref.userId)).toBe(quotas.memoriesPerUser);
    // The messages count as scanned anyway.
    expect(await marker(conversationId)).toBe(MESSAGES);
  });

  it('a TOPIC fact in a notebook without a topic is dropped', async () => {
    const conversationId = await createConversation(null);
    await seedMessages(conversationId);
    const ref = await aliceRef(conversationId);
    reply(addOp('Knows the basics.', { scope: 'TOPIC' }), addOp('Is a nurse.'));

    await run(ref);

    expect((await memoriesRepository.list(ref.userId)).map((m) => m.content)).toEqual([
      'Is a nurse.',
    ]);
  });

  it('scanned messages are not read again, so a deleted memory is not re-learned', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId);
    const ref = await aliceRef(conversationId);
    reply(addOp('Is a nurse.'));
    await run(ref);
    await memoriesRepository.deleteAll(ref.userId);

    const again = await run(ref);

    expect(again).toEqual({ status: 'stopped', reason: 'up_to_date' });
    expect(llm.requests).toHaveLength(1);
    expect(await memoriesRepository.count(ref.userId)).toBe(0);
  });

  it('only messages after the marker are sent; topic memories of other topics are not', async () => {
    const conversationId = await createConversation();
    const ref = await aliceRef(conversationId);
    await seedMessages(
      conversationId,
      20,
      Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`),
    );
    await db
      .update(conversations)
      .set({ memoryExtractedThroughSeq: 10 })
      .where(eq(conversations.id, conversationId));
    const otherConversation = await createConversation('Biology');
    await seedMessages(otherConversation);
    reply(addOp('Knows cells.', { scope: 'TOPIC' }));
    await run(await aliceRef(otherConversation));
    reply();

    await run(ref);

    const prompt = llm.requests[1]?.messages[0]?.content ?? '';
    expect(prompt).not.toContain('Line 5\n');
    expect(prompt).toContain('Learner: Line 6');
    expect(prompt).not.toContain('Knows cells.');
  });

  it("another user's conversation → not found", async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId);
    await createConversation('Statistics', BOB);

    expect(await service.draft({ conversationId, userId: await userIdOf('user_bob') })).toEqual({
      status: 'stopped',
      reason: 'not_found',
    });
    expect(llm.requests).toHaveLength(0);
  });

  it('a failed model call throws (the job retries); the marker stays', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId);
    llm.reply(new Error('model down'));

    await expect(service.draft(await aliceRef(conversationId))).rejects.toThrow('model down');
    expect(await marker(conversationId)).toBe(0);
  });

  it('runs as an Inngest function: draft then apply', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId);
    const ref = await aliceRef(conversationId);
    reply(addOp('Is a nurse.'));
    const client = createInngestClient({
      isDev: true,
      logger: testLogger,
      fetch: () => Promise.reject(new Error('network is blocked in tests')),
    });

    const { result, error } = await new InngestTestEngine({
      function: createExtractMemoriesFunction(client, service),
    }).execute({ events: [{ name: 'memory/extract', data: ref }] });

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: 'applied', added: 1, updated: 0, throughSeq: MESSAGES });
  });
});

describe('chat queues the extraction job', () => {
  it('once more than the threshold is unscanned', async () => {
    const conversationId = await createConversation();
    // The next question + answer bring it to exactly the threshold: not over it.
    await seedMessages(conversationId, memoryExtraction.afterMessages - 2);
    const send = (content: string) =>
      request(app)
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set('authorization', ALICE)
        .send({ id: crypto.randomUUID(), content });
    const extractEvents = () => jobs.sent.filter((e) => e.name === 'memory/extract');

    await send('One?');
    expect(extractEvents()).toEqual([]);

    await send('Two?');
    expect(extractEvents()).toEqual([
      { name: 'memory/extract', data: { conversationId, userId: await userIdOf('user_alice') } },
    ]);
  });
});
