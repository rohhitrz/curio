import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sourceChunks, sources, type NewSourceChunk } from '../db/schema/index.js';

/** Identifies the source a job run works on. Every query is scoped by both. */
export interface SourceRef {
  userId: string;
  sourceId: string;
}

/** A chunk ready to store; the repository adds the source and notebook IDs. */
export type ChunkToStore = Omit<NewSourceChunk, 'id' | 'sourceId' | 'notebookId' | 'createdAt'>;

export interface ExtractionToSave {
  /** Omitted to keep the current title. */
  title?: string;
  extractedText: string;
  extractedLocations: unknown;
  metadata: Record<string, unknown>;
}

export function createIngestionRepository(db: Db, chunkInsertBatchSize: number) {
  const owned = ({ userId, sourceId }: SourceRef) =>
    and(eq(sources.id, sourceId), eq(sources.userId, userId));
  /** Writes only land while the job owns the source, never on a deleted or finished one. */
  const processing = (ref: SourceRef) => and(owned(ref), eq(sources.status, 'PROCESSING'));

  return {
    /**
     * Claims a `PENDING` source for processing. Only one run can win: a duplicate run (the
     * sweeper re-sends events for sources that wait a long time) finds the source already taken
     * and stops, instead of processing a finished source all over again.
     */
    async markProcessing(ref: SourceRef): Promise<'claimed' | 'not_pending' | 'not_found'> {
      const rows = await db
        .update(sources)
        .set({
          status: 'PROCESSING',
          processingStartedAt: sql`now()`,
          errorCode: null,
          errorMessage: null,
        })
        .where(and(owned(ref), eq(sources.status, 'PENDING')))
        .returning({ id: sources.id });
      if (rows.length > 0) return 'claimed';

      const [existing] = await db
        .select({ id: sources.id })
        .from(sources)
        .where(owned(ref))
        .limit(1);
      return existing ? 'not_pending' : 'not_found';
    },

    /**
     * What extraction needs. Undefined when the source is gone or no longer processing.
     *
     * Reading at the start of a step also restarts the sweeper's clock (`processing_started_at`):
     * steps can wait in the job queue, and only a source that makes no progress should time out.
     */
    async findForExtraction(ref: SourceRef) {
      const [row] = await db
        .update(sources)
        .set({ processingStartedAt: sql`now()` })
        .where(processing(ref))
        .returning({
          type: sources.type,
          title: sources.title,
          url: sources.url,
          storageKey: sources.storageKey,
          contentHash: sources.contentHash,
          extractedText: sources.extractedText,
          metadata: sources.metadata,
        });
      return row;
    },

    async saveExtraction(ref: SourceRef, extraction: ExtractionToSave): Promise<boolean> {
      const rows = await db
        .update(sources)
        .set(extraction)
        .where(processing(ref))
        .returning({ id: sources.id });
      return rows.length > 0;
    },

    /**
     * The saved extraction. Undefined when the source is gone or no longer processing. Restarts
     * the sweeper's clock, like `findForExtraction`.
     */
    async findExtracted(ref: SourceRef) {
      const [row] = await db
        .update(sources)
        .set({ processingStartedAt: sql`now()` })
        .where(processing(ref))
        .returning({
          title: sources.title,
          extractedText: sources.extractedText,
          extractedLocations: sources.extractedLocations,
        });
      return row;
    },

    /**
     * Replaces the source's chunks and marks it `READY` in one transaction: all or nothing, so a
     * source is never half-indexed, and running it again gives the same result. False (and
     * nothing written) when the source was deleted or is no longer processing.
     */
    async commitChunks(
      ref: SourceRef,
      chunks: ChunkToStore[],
      embeddingModel: string,
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        // The lock also holds off a concurrent delete until the chunks are in.
        const [source] = await tx
          .select({ notebookId: sources.notebookId })
          .from(sources)
          .where(processing(ref))
          .for('update');
        if (!source) return false;

        await tx.delete(sourceChunks).where(eq(sourceChunks.sourceId, ref.sourceId));
        for (let start = 0; start < chunks.length; start += chunkInsertBatchSize) {
          await tx.insert(sourceChunks).values(
            chunks.slice(start, start + chunkInsertBatchSize).map((chunk) => ({
              ...chunk,
              sourceId: ref.sourceId,
              notebookId: source.notebookId,
            })),
          );
        }
        await tx
          .update(sources)
          .set({
            status: 'READY',
            chunkCount: chunks.length,
            embeddingModel,
            processedAt: sql`now()`,
            errorCode: null,
            errorMessage: null,
          })
          .where(eq(sources.id, ref.sourceId));
        return true;
      });
    },

    /**
     * Sweeper, across all users: fails every source that is `PROCESSING` and hasn't started a
     * step for longer than the timeout (its job died or hung). Returns how many.
     */
    async failStuckProcessing(
      timeoutMinutes: number,
      code: string,
      message: string,
    ): Promise<number> {
      const rows = await db
        .update(sources)
        .set({ status: 'FAILED', errorCode: code, errorMessage: message })
        .where(
          and(
            eq(sources.status, 'PROCESSING'),
            lt(sources.processingStartedAt, sql`now() - make_interval(mins => ${timeoutMinutes})`),
          ),
        )
        .returning({ id: sources.id });
      return rows.length;
    },

    /**
     * Sweeper, across all users: sources that have sat in `PENDING` for too long, oldest first.
     * Touching `updated_at` claims them, so the next sweep waits the full interval again before
     * re-sending the same source.
     */
    async claimStalePending(staleMinutes: number, limit: number): Promise<SourceRef[]> {
      const stale = db
        .select({ id: sources.id })
        .from(sources)
        .where(
          and(
            eq(sources.status, 'PENDING'),
            lt(sources.updatedAt, sql`now() - make_interval(mins => ${staleMinutes})`),
          ),
        )
        .orderBy(sources.updatedAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      return db
        .update(sources)
        .set({ updatedAt: sql`now()` })
        .where(inArray(sources.id, stale))
        .returning({ sourceId: sources.id, userId: sources.userId });
    },

    /** Marks a processing source `FAILED` with the reason. False when there was nothing to fail. */
    async markFailed(ref: SourceRef, code: string, message: string): Promise<boolean> {
      const rows = await db
        .update(sources)
        .set({ status: 'FAILED', errorCode: code, errorMessage: message })
        .where(processing(ref))
        .returning({ id: sources.id });
      return rows.length > 0;
    },
  };
}

export type IngestionRepository = ReturnType<typeof createIngestionRepository>;
