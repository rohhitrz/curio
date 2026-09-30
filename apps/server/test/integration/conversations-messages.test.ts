import { citationSnapshotsSchema, type CitationSnapshot } from '@curio/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { conversations, messages, notebooks, sources, users } from '../../src/db/schema/index.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const db = getTestDb();

async function seedConversation() {
  const [user] = await db.insert(users).values({ clerkUserId: 'user_chat' }).returning();
  if (!user) throw new Error('user not created');
  const [notebook] = await db
    .insert(notebooks)
    .values({ userId: user.id, title: 'ML', kind: 'SOURCE' })
    .returning();
  if (!notebook) throw new Error('notebook not created');
  const [conversation] = await db
    .insert(conversations)
    .values({ notebookId: notebook.id, userId: user.id, title: 'What is regularization?' })
    .returning();
  if (!conversation) throw new Error('conversation not created');
  return { user, notebook, conversation };
}

function citation(sourceId: string): CitationSnapshot {
  return {
    marker: 1,
    sourceId,
    sourceTitle: 'ML Lecture Notes',
    sourceType: 'PDF',
    snippet: 'Regularization adds a penalty term…',
    pageNumber: 12,
    startSeconds: null,
    headingPath: null,
    charStart: null,
    charEnd: null,
  };
}

beforeEach(async () => {
  await truncateAllTables();
});

describe('conversations', () => {
  it('starts with no summary, zero watermarks and last_message_at set', async () => {
    const { conversation } = await seedConversation();

    expect(conversation).toMatchObject({
      lessonId: null,
      summary: null,
      summarizedThroughSeq: 0,
      memoryExtractedThroughSeq: 0,
    });
    expect(conversation.lastMessageAt).toBeInstanceOf(Date);
  });

  it('the summary update only applies while the old watermark still matches', async () => {
    const { conversation } = await seedConversation();
    const update = (summary: string) =>
      db
        .update(conversations)
        .set({ summary, summarizedThroughSeq: 20 })
        .where(
          sql`${conversations.id} = ${conversation.id} and ${conversations.summarizedThroughSeq} = 0`,
        )
        .returning({ id: conversations.id });

    expect(await update('first')).toHaveLength(1);
    expect(await update('second')).toHaveLength(0);
    const [row] = await db.select().from(conversations);
    expect(row?.summary).toBe('first');
  });

  it('has the (notebook_id, last_message_at desc) index', async () => {
    const result = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes
           where indexname = 'conversations_notebook_id_last_message_at_idx'`,
    );

    expect(result.rows[0]?.indexdef).toContain('(notebook_id, last_message_at DESC');
  });
});

describe('messages', () => {
  it('stores a message with defaults and keeps a client-generated id', async () => {
    const { conversation } = await seedConversation();
    const id = crypto.randomUUID();

    const [row] = await db
      .insert(messages)
      .values({ id, conversationId: conversation.id, seq: 1, role: 'USER', content: 'Hi' })
      .returning();

    expect(row).toMatchObject({
      id,
      seq: 1,
      role: 'USER',
      citations: [],
      status: 'COMPLETE',
      traceId: null,
      feedback: null,
    });
  });

  it('round-trips citation snapshots that pass the shared schema', async () => {
    const { conversation } = await seedConversation();
    const citations = citationSnapshotsSchema.parse([citation(crypto.randomUUID())]);

    const [row] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        seq: 2,
        role: 'ASSISTANT',
        content: 'It adds a penalty [1].',
        citations,
        traceId: 'trace_1',
      })
      .returning();

    expect(citationSnapshotsSchema.parse(row?.citations)).toEqual(citations);
  });

  it('the same seq twice in one conversation is rejected', async () => {
    const { conversation } = await seedConversation();
    const message = {
      conversationId: conversation.id,
      seq: 1,
      role: 'USER',
      content: 'a',
    } as const;
    await db.insert(messages).values(message);

    await expect(db.insert(messages).values({ ...message, content: 'b' })).rejects.toThrow();
  });

  it('the same id twice is ignored with on conflict do nothing (resend = retry)', async () => {
    const { conversation } = await seedConversation();
    const message = {
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      seq: 1,
      role: 'USER',
      content: 'Hi',
    } as const;
    await db.insert(messages).values(message);

    const again = await db
      .insert(messages)
      .values({ ...message, seq: 2 })
      .onConflictDoNothing({ target: messages.id })
      .returning();

    expect(again).toEqual([]);
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('citations survive deleting the cited source (snapshots, not references)', async () => {
    const { user, notebook, conversation } = await seedConversation();
    const [source] = await db
      .insert(sources)
      .values({
        notebookId: notebook.id,
        userId: user.id,
        type: 'PDF',
        title: 'Notes',
        contentHash: 'h',
      })
      .returning();
    if (!source) throw new Error('source not created');
    await db.insert(messages).values({
      conversationId: conversation.id,
      seq: 1,
      role: 'ASSISTANT',
      content: 'Answer [1].',
      citations: [citation(source.id)],
    });

    await db.delete(sources).where(eq(sources.id, source.id));

    const [row] = await db.select().from(messages);
    expect(row?.citations[0]?.snippet).toBe('Regularization adds a penalty term…');
  });

  it('deleting the notebook deletes its conversations and their messages', async () => {
    const { notebook, conversation } = await seedConversation();
    await db
      .insert(messages)
      .values({ conversationId: conversation.id, seq: 1, role: 'USER', content: 'Hi' });

    await db.delete(notebooks).where(eq(notebooks.id, notebook.id));

    expect(await db.select().from(conversations)).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
  });
});
