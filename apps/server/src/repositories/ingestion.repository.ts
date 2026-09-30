import { and, eq, sql } from 'drizzle-orm';
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
    /** Claims the source for processing. False when it no longer exists. */
    async markProcessing(ref: SourceRef): Promise<boolean> {
      const rows = await db
        .update(sources)
        .set({
          status: 'PROCESSING',
          processingStartedAt: sql`now()`,
          errorCode: null,
          errorMessage: null,
        })
        .where(owned(ref))
        .returning({ id: sources.id });
      return rows.length > 0;
    },

    /** What extraction needs. Undefined when the source is gone or no longer processing. */
    async findForExtraction(ref: SourceRef) {
      const [row] = await db
        .select({
          type: sources.type,
          title: sources.title,
          url: sources.url,
          storageKey: sources.storageKey,
          contentHash: sources.contentHash,
          extractedText: sources.extractedText,
          metadata: sources.metadata,
        })
        .from(sources)
        .where(processing(ref))
        .limit(1);
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

    /** The saved extraction. Undefined when the source is gone or no longer processing. */
    async findExtracted(ref: SourceRef) {
      const [row] = await db
        .select({
          title: sources.title,
          extractedText: sources.extractedText,
          extractedLocations: sources.extractedLocations,
        })
        .from(sources)
        .where(processing(ref))
        .limit(1);
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
