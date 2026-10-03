import type { CitationSnapshot } from '@curio/shared';
import { and, asc, desc, eq, gt, lt, lte, max, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversations, messages, notebooks } from '../db/schema/index.js';
import type { Cursor } from '../pagination/cursor.js';

/** `last_message_at` as ISO text with microseconds, so cursors don't lose precision. */
const lastMessageAtText = sql<string>`to_char(${conversations.lastMessageAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const conversationColumns = {
  id: conversations.id,
  notebookId: conversations.notebookId,
  lessonId: conversations.lessonId,
  title: conversations.title,
  summary: conversations.summary,
  summarizedThroughSeq: conversations.summarizedThroughSeq,
  memoryExtractedThroughSeq: conversations.memoryExtractedThroughSeq,
  lastMessageAt: conversations.lastMessageAt,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
};

const messageColumns = {
  id: messages.id,
  conversationId: messages.conversationId,
  seq: messages.seq,
  role: messages.role,
  content: messages.content,
  citations: messages.citations,
  status: messages.status,
  traceId: messages.traceId,
  feedback: messages.feedback,
  createdAt: messages.createdAt,
};

export type ConversationRow = NonNullable<Awaited<ReturnType<ChatRepository['findConversation']>>>;
export type MessageRow = NonNullable<Awaited<ReturnType<ChatRepository['findMessage']>>>;

export interface NewAssistantMessage {
  id: string;
  conversationId: string;
  content: string;
  citations: CitationSnapshot[];
  status: 'COMPLETE' | 'ERROR';
  traceId: string | null;
  /** An `ERROR` answer this one replaces (retry): removed in the same transaction. */
  replacesId?: string;
  /** Set when the conversation still has its default title. */
  title?: string;
}

/** An open transaction. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Locks the conversation row and returns the next free `seq`. */
async function nextSeq(tx: Tx, conversationId: string): Promise<number> {
  await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('update');
  const [row] = await tx
    .select({ last: max(messages.seq) })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return (row?.last ?? 0) + 1;
}

export function createChatRepository(db: Db) {
  return {
    async notebookExists(userId: string, notebookId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: notebooks.id })
        .from(notebooks)
        .where(and(eq(notebooks.id, notebookId), eq(notebooks.userId, userId)))
        .limit(1);
      return row !== undefined;
    },

    /** Most recently active first. Fetches `limit + 1` rows to tell if there's a next page. */
    async listConversations(userId: string, notebookId: string, limit: number, cursor?: Cursor) {
      return db
        .select({ ...conversationColumns, cursorTimestamp: lastMessageAtText })
        .from(conversations)
        .where(
          and(
            eq(conversations.notebookId, notebookId),
            eq(conversations.userId, userId),
            cursor
              ? sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(limit + 1);
    },

    async createConversation(userId: string, notebookId: string, title: string) {
      const [row] = await db
        .insert(conversations)
        .values({ userId, notebookId, title })
        .returning(conversationColumns);
      if (!row) throw new Error('conversation not created');
      return row;
    },

    async findConversation(userId: string, conversationId: string) {
      const [row] = await db
        .select(conversationColumns)
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
        .limit(1);
      return row;
    },

    async updateConversationTitle(userId: string, conversationId: string, title: string) {
      const [row] = await db
        .update(conversations)
        .set({ title })
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
        .returning(conversationColumns);
      return row;
    },

    /** True if a row was deleted. Messages cascade. */
    async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
      const rows = await db
        .delete(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
        .returning({ id: conversations.id });
      return rows.length > 0;
    },

    /** Newest first; `beforeSeq` continues an earlier page. Fetches `limit + 1` rows. */
    async listMessages(conversationId: string, limit: number, beforeSeq?: number) {
      return db
        .select(messageColumns)
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            beforeSeq === undefined ? undefined : lt(messages.seq, beforeSeq),
          ),
        )
        .orderBy(desc(messages.seq))
        .limit(limit + 1);
    },

    /** The `count` messages before `beforeSeq`, oldest first (the chat history). */
    async recentMessages(conversationId: string, beforeSeq: number, count: number) {
      const rows = await db
        .select(messageColumns)
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), lt(messages.seq, beforeSeq)))
        .orderBy(desc(messages.seq))
        .limit(count);
      return rows.reverse();
    },

    /** Complete messages with `afterSeq < seq <= throughSeq`, oldest first (for the summary). */
    async completeMessagesBetween(conversationId: string, afterSeq: number, throughSeq: number) {
      return db
        .select(messageColumns)
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            gt(messages.seq, afterSeq),
            lte(messages.seq, throughSeq),
            eq(messages.status, 'COMPLETE'),
          ),
        )
        .orderBy(asc(messages.seq));
    },

    /**
     * Saves a new rolling summary only if no one else did since it was drafted (optimistic
     * concurrency, docs/03-database-design.md §8). False → another job got there first.
     */
    async saveSummary(update: {
      userId: string;
      conversationId: string;
      summary: string | null;
      throughSeq: number;
      expectedThroughSeq: number;
    }): Promise<boolean> {
      const rows = await db
        .update(conversations)
        .set({ summary: update.summary, summarizedThroughSeq: update.throughSeq })
        .where(
          and(
            eq(conversations.id, update.conversationId),
            eq(conversations.userId, update.userId),
            eq(conversations.summarizedThroughSeq, update.expectedThroughSeq),
          ),
        )
        .returning({ id: conversations.id });
      return rows.length > 0;
    },

    /**
     * Moves the memory-extraction marker, only if no other run moved it since it was read
     * (optimistic, like `saveSummary`). False → another run got there first.
     */
    async advanceMemoryMarker(update: {
      userId: string;
      conversationId: string;
      throughSeq: number;
      expectedThroughSeq: number;
    }): Promise<boolean> {
      const rows = await db
        .update(conversations)
        .set({ memoryExtractedThroughSeq: update.throughSeq })
        .where(
          and(
            eq(conversations.id, update.conversationId),
            eq(conversations.userId, update.userId),
            eq(conversations.memoryExtractedThroughSeq, update.expectedThroughSeq),
          ),
        )
        .returning({ id: conversations.id });
      return rows.length > 0;
    },

    async findMessage(messageId: string) {
      const [row] = await db
        .select(messageColumns)
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1);
      return row;
    },

    async messageAt(conversationId: string, seq: number) {
      const [row] = await db
        .select(messageColumns)
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.seq, seq)))
        .limit(1);
      return row;
    },

    async lastMessage(conversationId: string) {
      const [row] = await db
        .select(messageColumns)
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.seq))
        .limit(1);
      return row;
    },

    /**
     * Saves the user's message with the next `seq`. The client-generated ID makes a resend a
     * no-op: returns `inserted: false` with the row already there (possibly in another
     * conversation, which the caller rejects).
     */
    async insertUserMessage(conversationId: string, id: string, content: string) {
      return db.transaction(async (tx) => {
        const seq = await nextSeq(tx, conversationId);
        const [inserted] = await tx
          .insert(messages)
          .values({ id, conversationId, seq, role: 'USER', content })
          .onConflictDoNothing({ target: messages.id })
          .returning(messageColumns);
        if (inserted) {
          await tx
            .update(conversations)
            .set({ lastMessageAt: sql`now()` })
            .where(eq(conversations.id, conversationId));
          return { message: inserted, inserted: true as const };
        }
        const [existing] = await tx
          .select(messageColumns)
          .from(messages)
          .where(eq(messages.id, id))
          .limit(1);
        if (!existing) throw new Error(`message ${id} conflicted but is missing`);
        return { message: existing, inserted: false as const };
      });
    },

    /** Saves an answer after the latest message, replacing an `ERROR` answer on retry. */
    async saveAssistantMessage(message: NewAssistantMessage) {
      return db.transaction(async (tx) => {
        if (message.replacesId) {
          await tx
            .delete(messages)
            .where(
              and(
                eq(messages.id, message.replacesId),
                eq(messages.conversationId, message.conversationId),
              ),
            );
        }
        const seq = await nextSeq(tx, message.conversationId);
        const [row] = await tx
          .insert(messages)
          .values({
            id: message.id,
            conversationId: message.conversationId,
            seq,
            role: 'ASSISTANT',
            content: message.content,
            citations: message.citations,
            status: message.status,
            traceId: message.traceId,
          })
          .returning(messageColumns);
        await tx
          .update(conversations)
          .set({
            lastMessageAt: sql`now()`,
            ...(message.title ? { title: message.title } : {}),
          })
          .where(eq(conversations.id, message.conversationId));
        if (!row) throw new Error('assistant message not saved');
        return row;
      });
    },

    /** Sets or clears feedback on one of the user's answers. Undefined if it isn't theirs. */
    async setFeedback(userId: string, messageId: string, value: 'UP' | 'DOWN' | null) {
      const [row] = await db
        .update(messages)
        .set({ feedback: value })
        .from(conversations)
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.role, 'ASSISTANT'),
            eq(conversations.id, messages.conversationId),
            eq(conversations.userId, userId),
          ),
        )
        .returning(messageColumns);
      return row;
    },
  };
}

export type ChatRepository = ReturnType<typeof createChatRepository>;
