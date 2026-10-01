import { InngestTestEngine } from '@inngest/test';
import { conversationSchema, notebookSchema } from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { conversation as conversationLimits } from '../../src/config/index.js';
import {
  conversations,
  messages,
  sourceChunks,
  sources,
  users,
} from '../../src/db/schema/index.js';
import { createSummarizeConversationFunction } from '../../src/inngest/summarize-conversation.js';
import { createInngestClient } from '../../src/lib/jobs/index.js';
import { CONVERSATION_SUMMARY_INSTRUCTIONS } from '../../src/pipelines/memory/summarize.js';
import { createChatRepository } from '../../src/repositories/chat.repository.js';
import {
  createConversationSummaryService,
  type ConversationSummaryService,
} from '../../src/services/conversation-summary.service.js';
import { fakeVector } from '../fakes/embeddings.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { createFakeLlm, type FakeLlm } from '../fakes/llm.js';
import { createFakeTracer, type FakeTracer } from '../fakes/tracing.js';
import { bearer, createTestApp, testLogger } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const db = getTestDb();
const { recentMessages, summarizeAfterMessages } = conversationLimits;

let llm: FakeLlm;
let tracer: FakeTracer;
let jobs: FakeJobs;
let app: ReturnType<typeof createTestApp>;
let service: ConversationSummaryService;

beforeEach(async () => {
  await truncateAllTables();
  llm = createFakeLlm();
  tracer = createFakeTracer();
  jobs = createFakeJobs();
  app = createTestApp({ llm, tracer, jobs });
  service = createConversationSummaryService({
    repository: createChatRepository(db),
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

/** A conversation of Alice's (no sources: the chat answers "not in your sources"). */
async function createConversation(auth = ALICE) {
  const notebook = await request(app)
    .post('/api/v1/notebooks')
    .set('authorization', auth)
    .send({ title: 'ML' });
  const res = await request(app)
    .post(`/api/v1/notebooks/${notebookSchema.parse(notebook.body).id}/conversations`)
    .set('authorization', auth)
    .send({});
  return conversationSchema.parse(res.body).id;
}

/** Messages 1..count, alternating question / answer; `error` seqs are failed answers. */
async function seedMessages(conversationId: string, count: number, error: number[] = []) {
  await db.insert(messages).values(
    Array.from({ length: count }, (_, i) => {
      const seq = i + 1;
      const isUser = seq % 2 === 1;
      return {
        conversationId,
        seq,
        role: isUser ? ('USER' as const) : ('ASSISTANT' as const),
        content: isUser ? `Question ${seq}` : `Answer ${seq} [1]`,
        status: error.includes(seq) ? ('ERROR' as const) : ('COMPLETE' as const),
      };
    }),
  );
}

/** A `READY` source with one chunk in the conversation's notebook, so the model is called. */
async function addReadySource(conversationId: string) {
  const row = await conversationRow(conversationId);
  const [source] = await db
    .insert(sources)
    .values({
      notebookId: row.notebookId,
      userId: row.userId,
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
    notebookId: row.notebookId,
    chunkIndex: 0,
    content,
    contextHeader: 'ML Notes',
    embedding: fakeVector(content),
    tokenCount: 10,
  });
}

async function conversationRow(conversationId: string) {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!row) throw new Error('conversation missing');
  return row;
}

async function aliceRef(conversationId: string) {
  return { conversationId, userId: await userIdOf('user_alice') };
}

describe('summary job', () => {
  it('summarizes all but the last ~10 messages and saves the marker', async () => {
    const conversationId = await createConversation();
    const total = summarizeAfterMessages + 2;
    await seedMessages(conversationId, total);
    const ref = await aliceRef(conversationId);
    llm.reply('The learner asked twelve questions.');

    const draft = await service.draft(ref);
    if (draft.status !== 'drafted') throw new Error(`not drafted: ${draft.status}`);
    const saved = await service.save(ref, draft);

    const through = total - recentMessages;
    expect(saved).toEqual({ status: 'saved', throughSeq: through });
    const row = await conversationRow(conversationId);
    expect(row.summary).toBe('The learner asked twelve questions.');
    expect(row.summarizedThroughSeq).toBe(through);

    const prompt = llm.requests[0]?.messages[0]?.content ?? '';
    expect(llm.requests[0]?.instructions).toBe(CONVERSATION_SUMMARY_INSTRUCTIONS);
    expect(prompt).toContain('Learner: Question 1');
    expect(prompt).toContain(`Curio: Answer ${through}`);
    expect(prompt).not.toContain(`Question ${through + 1}`);
    expect(prompt).not.toContain('[1]');
    expect(tracer.traces.map((t) => t.name)).toEqual(['conversation-summary']);
  });

  it('folds the previous summary in and starts after its marker', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId, 40);
    await db
      .update(conversations)
      .set({ summary: 'Earlier: dropout.', summarizedThroughSeq: 10 })
      .where(eq(conversations.id, conversationId));
    const ref = await aliceRef(conversationId);
    llm.reply('Dropout, then weight decay.');

    const draft = await service.draft(ref);

    expect(draft).toEqual({
      status: 'drafted',
      summary: 'Dropout, then weight decay.',
      throughSeq: 40 - recentMessages,
      expectedThroughSeq: 10,
    });
    const prompt = llm.requests[0]?.messages[0]?.content ?? '';
    expect(prompt).toContain('Summary so far:\nEarlier: dropout.');
    expect(prompt).not.toContain('Question 9\n');
    expect(prompt).toContain('Learner: Question 11');
  });

  it('two summary jobs at once: only one update applies', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId, summarizeAfterMessages + 2);
    const ref = await aliceRef(conversationId);
    llm.reply('First summary.', 'Second summary.');

    // Both draft from the same starting point, then race to save.
    const [first, second] = await Promise.all([service.draft(ref), service.draft(ref)]);
    if (first.status !== 'drafted' || second.status !== 'drafted') throw new Error('not drafted');
    const results = await Promise.all([service.save(ref, first), service.save(ref, second)]);

    expect(results.map((r) => r.status).sort()).toEqual(['saved', 'stopped']);
    const winner = results[0].status === 'saved' ? first : second;
    const row = await conversationRow(conversationId);
    expect(row.summary).toBe(winner.summary);
    expect(row.summarizedThroughSeq).toBe(winner.throughSeq);
  });

  it('nothing to do at or below the threshold: no model call', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId, summarizeAfterMessages);

    expect(await service.draft(await aliceRef(conversationId))).toEqual({
      status: 'stopped',
      reason: 'up_to_date',
    });
    expect(llm.requests).toHaveLength(0);
  });

  it('leaves failed answers out of the summary', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId, summarizeAfterMessages + 2, [4]);
    llm.reply('Summary.');

    await service.draft(await aliceRef(conversationId));

    const prompt = llm.requests[0]?.messages[0]?.content ?? '';
    expect(prompt).toContain('Answer 2');
    expect(prompt).not.toContain('Answer 4');
  });

  it("another user's conversation → not found, nothing changes", async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId, summarizeAfterMessages + 2);
    await createConversation(BOB);
    const bob = { conversationId, userId: await userIdOf('user_bob') };

    expect(await service.draft(bob)).toEqual({ status: 'stopped', reason: 'not_found' });
    const saved = await service.save(bob, {
      status: 'drafted',
      summary: 'Bob was here.',
      throughSeq: 12,
      expectedThroughSeq: 0,
    });
    expect(saved.status).toBe('stopped');
    expect((await conversationRow(conversationId)).summary).toBeNull();
  });

  it('runs as an Inngest function: draft then save; a second run finds nothing to do', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId, summarizeAfterMessages + 2);
    const ref = await aliceRef(conversationId);
    llm.reply('Summary.');
    const client = createInngestClient({
      isDev: true,
      logger: testLogger,
      fetch: () => Promise.reject(new Error('network is blocked in tests')),
    });
    const run = () =>
      new InngestTestEngine({
        function: createSummarizeConversationFunction(client, service),
      }).execute({ events: [{ name: 'conversation/summarize', data: ref }] });

    const firstRun = await run();
    expect(firstRun.error).toBeUndefined();
    expect(firstRun.result).toEqual({
      status: 'saved',
      throughSeq: summarizeAfterMessages + 2 - recentMessages,
    });

    const secondRun = await run();
    expect(secondRun.result).toEqual({ status: 'stopped', reason: 'up_to_date' });
    expect(llm.requests).toHaveLength(1);
  });

  it('a failed model call throws, so the job retries; nothing is saved', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId, summarizeAfterMessages + 2);
    llm.reply(new Error('model down'));

    await expect(service.draft(await aliceRef(conversationId))).rejects.toThrow('model down');
    expect((await conversationRow(conversationId)).summarizedThroughSeq).toBe(0);
  });
});

describe('chat with a summary', () => {
  const send = (conversationId: string, content: string) =>
    request(app)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('authorization', ALICE)
      .send({ id: crypto.randomUUID(), content });

  it('context = summary + last ~10 messages only', async () => {
    const conversationId = await createConversation();
    await addReadySource(conversationId);
    await seedMessages(conversationId, 30);
    await db
      .update(conversations)
      .set({ summary: 'Earlier: dropout and weight decay.', summarizedThroughSeq: 20 })
      .where(eq(conversations.id, conversationId));
    llm.reply('Dropout drops units [1].');

    await send(conversationId, 'What about dropout?');

    const sent = llm.requests[0]?.messages ?? [];
    expect(sent[0]?.content).toBe(
      'Summary of our earlier conversation:\nEarlier: dropout and weight decay.',
    );
    expect(sent[1]?.content).toBe('Understood.');
    // Seqs 21–30, then the question with the sources.
    expect(sent.slice(2, -1).map((m) => m.content)).toEqual(
      Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0 ? `Question ${21 + i}` : `Answer ${21 + i}`,
      ),
    );
    expect(sent.at(-1)?.content).toContain('Question: What about dropout?');
    expect(JSON.stringify(sent)).not.toContain('Question 19');
  });

  it('queues the summary job once more than the threshold sits outside the summary', async () => {
    const conversationId = await createConversation();
    // The next question and its answer are seqs threshold - 1 and threshold: not over it yet.
    await seedMessages(conversationId, summarizeAfterMessages - 2);
    await send(conversationId, 'One more?');
    expect(jobs.sent.filter((e) => e.name === 'conversation/summarize')).toEqual([]);

    // Seqs threshold + 1 and + 2: over it.
    await send(conversationId, 'And another?');
    expect(jobs.sent.filter((e) => e.name === 'conversation/summarize')).toEqual([
      {
        name: 'conversation/summarize',
        data: { conversationId, userId: await userIdOf('user_alice') },
      },
    ]);
  });

  it('the job service is down: the answer is still saved as COMPLETE', async () => {
    const conversationId = await createConversation();
    await seedMessages(conversationId, summarizeAfterMessages);
    jobs.failNextSend(new Error('Inngest down'));

    const res = await send(conversationId, 'Still there?');

    expect(res.status).toBe(200);
    const [last] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.seq)
      .then((rows) => rows.slice(-1));
    expect(last?.role).toBe('ASSISTANT');
    expect(last?.status).toBe('COMPLETE');
  });
});
