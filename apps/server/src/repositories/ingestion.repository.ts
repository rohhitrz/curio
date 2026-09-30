import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sourceChunks, sources, type NewSourceChunk } from '../db/schema/index.js';

/** Identifies a source. Every query is scoped by both. */
export interface SourceRef {
  userId: string;
  sourceId: string;
}

/** A source as one job run works on it: the run's writes only land while it owns the source. */
export interface RunRef extends SourceRef {
  /** The job run's ID; the same across retries of that run's steps. */
  runId: string;
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
  /**
   * Writes only land while this run owns the source: never on a deleted or finished source, and
   * never from a duplicate or superseded run.
   */
  const processing = (ref: RunRef) =>
    and(owned(ref), eq(sources.status, 'PROCESSING'), eq(sources.processingRunId, ref.runId));

  return {
    /**
     * Claims a `PENDING` source for this run. Only one run can win: a duplicate run (the sweeper
     * re-sends events for sources that wait a long time) finds the source taken and stops,
     * instead of processing a finished source all over again. The winning run can claim again:
     * if this step's first attempt committed but the job service never recorded it, the retry
     * must not stop its own run.
     */
    async markProcessing(ref: RunRef): Promise<'claimed' | 'not_pending' | 'not_found'> {
      const rows = await db
        .update(sources)
        .set({
          status: 'PROCESSING',
          processingRunId: ref.runId,
          processingStartedAt: sql`now()`,
          errorCode: null,
          errorMessage: null,
        })
        .where(
          and(
            owned(ref),
            or(
              eq(sources.status, 'PENDING'),
              and(eq(sources.status, 'PROCESSING'), eq(sources.processingRunId, ref.runId)),
            ),
          ),
        )
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
     * What extraction needs. Undefined when the source is gone or this run no longer owns it.
     *
     * Reading at the start of a step also restarts the sweeper's clock (`processing_started_at`),
     * so time spent across earlier steps doesn't add up. A step that waits in the job queue for
     * longer than the timeout before it starts is still timed out: the database can't tell that
     * wait from a dead run (known limit, docs/03-database-design.md).
     */
    async findForExtraction(ref: RunRef) {
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

    async saveExtraction(ref: RunRef, extraction: ExtractionToSave): Promise<boolean> {
      const rows = await db
        .update(sources)
        .set(extraction)
        .where(processing(ref))
        .returning({ id: sources.id });
      return rows.length > 0;
    },

    /**
     * The saved extraction. Undefined when the source is gone or this run no longer owns it. Restarts
     * the sweeper's clock, like `findForExtraction`.
     */
    async findExtracted(ref: RunRef) {
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
     * nothing written) when the source was deleted or this run no longer owns it.
     */
    async commitChunks(
      ref: RunRef,
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

    /** Marks the source `FAILED` with the reason while this run owns it. False otherwise. */
    async markFailed(ref: RunRef, code: string, message: string): Promise<boolean> {
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
