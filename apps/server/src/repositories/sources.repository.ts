import { and, asc, count, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { notebooks, sources } from '../db/schema/index.js';

const columns = {
  id: sources.id,
  notebookId: sources.notebookId,
  type: sources.type,
  origin: sources.origin,
  title: sources.title,
  status: sources.status,
  errorCode: sources.errorCode,
  errorMessage: sources.errorMessage,
  url: sources.url,
  chunkCount: sources.chunkCount,
  metadata: sources.metadata,
  createdAt: sources.createdAt,
  updatedAt: sources.updatedAt,
  processedAt: sources.processedAt,
};

export interface NewSource {
  type: (typeof sources.type.enumValues)[number];
  title: string;
  contentHash: string;
  url?: string;
  storageKey?: string;
  extractedText?: string;
  metadata?: Record<string, unknown>;
}

export type SourceRow = Pick<typeof sources.$inferSelect, keyof typeof columns>;

export type CreateSourceResult =
  | { kind: 'created'; row: SourceRow }
  | { kind: 'duplicate'; existingId: string }
  | { kind: 'quota' }
  | { kind: 'upload_used' }
  | { kind: 'notebook_not_found' };

export function createSourcesRepository(db: Db) {
  async function ownsNotebook(userId: string, notebookId: string) {
    const [notebook] = await db
      .select({ id: notebooks.id })
      .from(notebooks)
      .where(and(eq(notebooks.id, notebookId), eq(notebooks.userId, userId)))
      .limit(1);
    return notebook !== undefined;
  }

  return {
    ownsNotebook,

    /** Source count in the user's notebook, or undefined if the notebook isn't theirs. */
    async countInNotebook(userId: string, notebookId: string) {
      if (!(await ownsNotebook(userId, notebookId))) return undefined;

      const [row] = await db
        .select({ n: count() })
        .from(sources)
        .where(eq(sources.notebookId, notebookId));
      return row?.n ?? 0;
    },

    /** Oldest first, never `extracted_text`. Undefined if the notebook isn't the user's. */
    async listByNotebook(userId: string, notebookId: string) {
      if (!(await ownsNotebook(userId, notebookId))) return undefined;
      return db
        .select(columns)
        .from(sources)
        .where(and(eq(sources.notebookId, notebookId), eq(sources.userId, userId)))
        .orderBy(asc(sources.createdAt), asc(sources.id));
    },

    async findById(userId: string, sourceId: string) {
      const [row] = await db
        .select({ ...columns, storageKey: sources.storageKey })
        .from(sources)
        .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
        .limit(1);
      return row;
    },

    async updateTitle(userId: string, sourceId: string, title: string) {
      const [row] = await db
        .update(sources)
        .set({ title })
        .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
        .returning(columns);
      return row;
    },

    /** Deletes the row (chunks cascade). Returns the R2 key to clean up, or undefined if nothing was deleted. */
    async delete(userId: string, sourceId: string) {
      const [row] = await db
        .delete(sources)
        .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
        .returning({ storageKey: sources.storageKey });
      return row;
    },

    /**
     * Adds a source unless it's a duplicate or the notebook is full. Locking the notebook row
     * checks ownership and serializes concurrent adds, so the count can't race. The unique
     * `(notebook_id, content_hash)` and `storage_key` constraints are the backstops: an upload used
     * from another notebook isn't serialized by this lock.
     */
    async createWithinQuota(
      userId: string,
      notebookId: string,
      values: NewSource,
      max: number,
    ): Promise<CreateSourceResult> {
      return db.transaction(async (tx): Promise<CreateSourceResult> => {
        const [notebook] = await tx
          .select({ id: notebooks.id })
          .from(notebooks)
          .where(and(eq(notebooks.id, notebookId), eq(notebooks.userId, userId)))
          .for('no key update');
        if (!notebook) return { kind: 'notebook_not_found' };

        const findDuplicate = async () => {
          const [existing] = await tx
            .select({ id: sources.id })
            .from(sources)
            .where(
              and(eq(sources.notebookId, notebookId), eq(sources.contentHash, values.contentHash)),
            )
            .limit(1);
          return existing;
        };

        /** An uploaded file can back only one source; deleting that source deletes the file. */
        const isUploadUsed = async () => {
          if (values.storageKey === undefined) return false;
          const [used] = await tx
            .select({ id: sources.id })
            .from(sources)
            .where(eq(sources.storageKey, values.storageKey))
            .limit(1);
          return used !== undefined;
        };

        const duplicate = await findDuplicate();
        if (duplicate) return { kind: 'duplicate', existingId: duplicate.id };
        if (await isUploadUsed()) return { kind: 'upload_used' };

        const [existing] = await tx
          .select({ n: count() })
          .from(sources)
          .where(eq(sources.notebookId, notebookId));
        if ((existing?.n ?? 0) >= max) return { kind: 'quota' };

        const [row] = await tx
          .insert(sources)
          .values({ ...values, notebookId, userId })
          // Any unique conflict (hash or storage key) means a concurrent add won; see which.
          .onConflictDoNothing()
          .returning(columns);
        if (row) return { kind: 'created', row };

        const raced = await findDuplicate();
        if (raced) return { kind: 'duplicate', existingId: raced.id };
        if (await isUploadUsed()) return { kind: 'upload_used' };
        throw new Error('source insert conflicted but no conflicting source was found');
      });
    },
  };
}

export type SourcesRepository = ReturnType<typeof createSourcesRepository>;
