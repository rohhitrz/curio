import { conversationSchema, messageListSchema, notebookSchema } from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { quotas } from '../../src/config/index.js';
import { sourceChunks, sources, topics, users } from '../../src/db/schema/index.js';
import { createMemoriesRepository } from '../../src/repositories/memories.repository.js';
import { fakeVector } from '../fakes/embeddings.js';
import { createFakeLlm, type FakeLlm } from '../fakes/llm.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const db = getTestDb();
const memories = createMemoriesRepository(db);
const CAP = quotas.memoriesPerUser;

let llm: FakeLlm;
let app: ReturnType<typeof createTestApp>;

beforeEach(async () => {
  await truncateAllTables();
  llm = createFakeLlm();
  app = createTestApp({ llm });
});

async function aliceId(): Promise<string> {
  const [user] = await db.select().from(users).where(eq(users.clerkUserId, 'user_alice'));
  if (!user) throw new Error('alice missing');
  return user.id;
}

/** A notebook with `topic`, one READY source, and a conversation in it. */
async function setup(topic = 'Statistics') {
  const created = await request(app)
    .post('/api/v1/notebooks')
    .set('authorization', ALICE)
    .send({ title: 'Stats' });
  const notebookId = notebookSchema.parse(created.body).id;
  await request(app)
    .patch(`/api/v1/notebooks/${notebookId}`)
    .set('authorization', ALICE)
    .send({ topic });
  const userId = await aliceId();
  const [source] = await db
    .insert(sources)
    .values({
      notebookId,
      userId,
      type: 'TEXT',
      title: 'Notes',
      status: 'READY',
      contentHash: crypto.randomUUID(),
      chunkCount: 1,
    })
    .returning();
  if (!source) throw new Error('source missing');
  const content = 'Variance is the average squared deviation from the mean.';
  await db.insert(sourceChunks).values({
    sourceId: source.id,
    notebookId,
    chunkIndex: 0,
    content,
    contextHeader: 'Notes',
    embedding: fakeVector(content),
    tokenCount: 10,
  });
  const conversation = await request(app)
    .post(`/api/v1/notebooks/${notebookId}/conversations`)
    .set('authorization', ALICE)
    .send({});
  const [topicRow] = await db.select().from(topics).where(eq(topics.name, topic));
  return {
    userId,
    sourceId: source.id,
    topicId: topicRow?.id ?? null,
    conversationId: conversationSchema.parse(conversation.body).id,
  };
}

const send = (conversationId: string, content: string) =>
  request(app)
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set('authorization', ALICE)
    .send({ id: crypto.randomUUID(), content });

describe('memory in the chat prompt', () => {
  it("global memories and the notebook topic's memories shape the prompt; other topics don't", async () => {
    const { userId, topicId, conversationId } = await setup();
    const [biology] = await db
      .insert(topics)
      .values({ name: 'Biology', normalizedName: 'biology', embedding: fakeVector('Biology') })
      .returning();
    if (!topicId || !biology) throw new Error('topics missing');
    await memories.insertWithinCap(
      userId,
      { topicId: null, kind: 'STYLE', content: 'Likes analogies.', origin: 'CHAT_EXTRACTED' },
      CAP,
    );
    await memories.upsertLevel(
      userId,
      { topicId, level: 'BEGINNER', content: 'Beginner', origin: 'LEVEL_CONFIRMED' },
      CAP,
    );
    await memories.insertWithinCap(
      userId,
      { topicId: biology.id, kind: 'FACT', content: 'Knows cells.', origin: 'CHAT_EXTRACTED' },
      CAP,
    );
    llm.reply('Variance measures spread [1].');

    await send(conversationId, 'What is variance?');

    const sent = llm.requests[0]?.messages ?? [];
    expect(sent[0]?.content).toContain('- Level (Statistics): beginner');
    expect(sent[0]?.content).toContain('- Style: Likes analogies.');
    expect(JSON.stringify(sent)).not.toContain('Knows cells');
    expect(sent.at(-1)?.content).not.toContain('Likes analogies');
  });

  it('memories never appear as citations', async () => {
    const { userId, sourceId, conversationId } = await setup();
    await memories.insertWithinCap(
      userId,
      { topicId: null, kind: 'FACT', content: 'Is a nurse.', origin: 'CHAT_EXTRACTED' },
      CAP,
    );
    // The model tries to cite a second "source" (the profile): only [1] exists.
    llm.reply('As a nurse you know averages [2]. Variance measures spread [1].');

    await send(conversationId, 'What is variance?');

    const list = await request(app)
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set('authorization', ALICE);
    const answer = messageListSchema.parse(list.body).items[0];
    expect(answer?.content).toBe('As a nurse you know averages. Variance measures spread [1].');
    expect(answer?.citations.map((c) => c.sourceId)).toEqual([sourceId]);
    expect(JSON.stringify(answer?.citations)).not.toContain('nurse');
  });

  it('no memories → no profile turn', async () => {
    const { conversationId } = await setup();
    llm.reply('Variance measures spread [1].');

    await send(conversationId, 'What is variance?');

    const sent = llm.requests[0]?.messages ?? [];
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toContain('Question: What is variance?');
  });
});
