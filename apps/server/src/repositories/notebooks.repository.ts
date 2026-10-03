import { and, count, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversations, notebooks, sources, topics } from '../db/schema/index.js';
import type { Cursor } from '../pagination/cursor.js';

/** `updated_at` as ISO text with microseconds, so cursors don't lose precision. */
const updatedAtText = sql<string>`to_char(${notebooks.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const columns = {
  id: notebooks.id,
  title: notebooks.title,
  kind: notebooks.kind,
  createdAt: notebooks.createdAt,
  updatedAt: notebooks.updatedAt,
};

/** `columns` plus the topic, for reads joined with `topics`. */
const withTopic = { ...columns, topicId: topics.id, topicName: topics.name };

export type NotebookRow = Awaited<ReturnType<NotebooksRepository['findById']>> & {};

export function createNotebooksRepository(db: Db) {
  return {
    /** Newest-updated first. Fetches `limit + 1` rows so the caller can tell if there's a next page. */
    async listByUser(userId: string, limit: number, cursor?: Cursor) {
      return db
        .select({ ...withTopic, cursorTimestamp: updatedAtText })
        .from(notebooks)
        .leftJoin(topics, eq(topics.id, notebooks.topicId))
        .where(
          and(
            eq(notebooks.userId, userId),
            cursor
              ? sql`(${notebooks.updatedAt}, ${notebooks.id}) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(notebooks.updatedAt), desc(notebooks.id))
        .limit(limit + 1);
    },

    async findById(userId: string, notebookId: string) {
      const [row] = await db
        .select(withTopic)
        .from(notebooks)
        .leftJoin(topics, eq(topics.id, notebooks.topicId))
        .where(and(eq(notebooks.id, notebookId), eq(notebooks.userId, userId)))
        .limit(1);
      return row;
    },

    async countSources(notebookId: string) {
      const [row] = await db
        .select({ n: count() })
        .from(sources)
        .where(eq(sources.notebookId, notebookId));
      return row?.n ?? 0;
    },

    async countConversations(notebookId: string) {
      const [row] = await db
        .select({ n: count() })
        .from(conversations)
        .where(eq(conversations.notebookId, notebookId));
      return row?.n ?? 0;
    },

    /**
     * Creates a SOURCE notebook unless the user is at `max`. A per-user advisory lock makes the
     * count + insert atomic, so parallel creates can't exceed the quota.
     * Returns undefined when the quota is reached.
     */
    async createWithinQuota(userId: string, title: string, max: number) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notebooks:${userId}`}))`);
        const [existing] = await tx
          .select({ n: count() })
          .from(notebooks)
          .where(eq(notebooks.userId, userId));
        if ((existing?.n ?? 0) >= max) return undefined;

        const [row] = await tx
          .insert(notebooks)
          .values({ userId, title, kind: 'SOURCE' })
          .returning(columns);
        return row && { ...row, topicId: null, topicName: null };
      });
    },

    /** Sets the title and/or topic (`topicId: null` clears it). Undefined if not the user's. */
    async update(
      userId: string,
      notebookId: string,
      changes: { title?: string; topicId?: string | null },
    ) {
      const updated = await db
        .update(notebooks)
        .set(changes)
        .where(and(eq(notebooks.id, notebookId), eq(notebooks.userId, userId)))
        .returning({ id: notebooks.id });
      if (updated.length === 0) return undefined;
      return this.findById(userId, notebookId);
    },

    /** Returns true if a row was deleted. */
    /**
     * Deletes the notebook; its sources and chunks cascade. Returns the R2 keys of its uploaded
     * files, read in the same transaction because the rows are gone afterwards. Undefined when
     * the notebook isn't the user's.
     */
    async delete(
      userId: string,
      notebookId: string,
    ): Promise<{ storageKeys: string[] } | undefined> {
      return db.transaction(async (tx) => {
        const [notebook] = await tx
          .select({ id: notebooks.id })
          .from(notebooks)
          .where(and(eq(notebooks.id, notebookId), eq(notebooks.userId, userId)))
          .for('update');
        if (!notebook) return undefined;

        const files = await tx
          .select({ storageKey: sources.storageKey })
          .from(sources)
          .where(and(eq(sources.notebookId, notebookId), isNotNull(sources.storageKey)));
        await tx.delete(notebooks).where(eq(notebooks.id, notebookId));

        return { storageKeys: files.flatMap((file) => file.storageKey ?? []) };
      });
    },
  };
}

export type NotebooksRepository = ReturnType<typeof createNotebooksRepository>;
