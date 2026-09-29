import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { notebooks, sources } from '../db/schema/index.js';
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

export type NotebookRow = Awaited<ReturnType<NotebooksRepository['findById']>> & {};

export function createNotebooksRepository(db: Db) {
  return {
    /** Newest-updated first. Fetches `limit + 1` rows so the caller can tell if there's a next page. */
    async listByUser(userId: string, limit: number, cursor?: Cursor) {
      return db
        .select({ ...columns, cursorTimestamp: updatedAtText })
        .from(notebooks)
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
        .select(columns)
        .from(notebooks)
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
        return row;
      });
    },

    async updateTitle(userId: string, notebookId: string, title: string) {
      const [row] = await db
        .update(notebooks)
        .set({ title })
        .where(and(eq(notebooks.id, notebookId), eq(notebooks.userId, userId)))
        .returning(columns);
      return row;
    },

    /** Returns true if a row was deleted. */
    async delete(userId: string, notebookId: string) {
      const rows = await db
        .delete(notebooks)
        .where(and(eq(notebooks.id, notebookId), eq(notebooks.userId, userId)))
        .returning({ id: notebooks.id });
      return rows.length > 0;
    },
  };
}

export type NotebooksRepository = ReturnType<typeof createNotebooksRepository>;
