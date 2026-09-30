import { and, cosineDistance, eq, sql } from 'drizzle-orm';
import { retrieval } from '../config/index.js';
import type { Db } from '../db/client.js';
import { sourceChunks, sources } from '../db/schema/index.js';

/** An open transaction. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type HnswIterativeScan = 'off' | 'strict_order' | 'relaxed_order';

export interface VectorSearchParams {
  userId: string;
  notebookId: string;
  embedding: number[];
  limit: number;
}

export type VectorSearchRow = Awaited<ReturnType<typeof nearestChunks>>[number];

/**
 * The chunks nearest to `embedding` in one of the user's notebooks, nearest first. Only `READY`
 * sources count: a failed reprocess keeps its old chunks, and those must not be searched.
 *
 * Must run inside a transaction: the iterative-scan setting is `SET LOCAL`, so it never leaks to
 * other queries on a pooled connection.
 */
export async function nearestChunks(
  tx: Tx,
  { userId, notebookId, embedding, limit }: VectorSearchParams,
  iterativeScan: HnswIterativeScan = retrieval.hnswIterativeScan,
) {
  await tx.execute(sql`select set_config('hnsw.iterative_scan', ${iterativeScan}, true)`);

  const distance = cosineDistance(sourceChunks.embedding, embedding);
  return tx
    .select({
      chunkId: sourceChunks.id,
      sourceId: sourceChunks.sourceId,
      sourceTitle: sources.title,
      sourceType: sources.type,
      chunkIndex: sourceChunks.chunkIndex,
      content: sourceChunks.content,
      contextHeader: sourceChunks.contextHeader,
      pageNumber: sourceChunks.pageNumber,
      startSeconds: sourceChunks.startSeconds,
      endSeconds: sourceChunks.endSeconds,
      headingPath: sourceChunks.headingPath,
      charStart: sourceChunks.charStart,
      charEnd: sourceChunks.charEnd,
      distance: sql<number>`${distance}`.mapWith(Number),
    })
    .from(sourceChunks)
    .innerJoin(sources, eq(sources.id, sourceChunks.sourceId))
    .where(
      and(
        eq(sourceChunks.notebookId, notebookId),
        eq(sources.userId, userId),
        eq(sources.status, 'READY'),
      ),
    )
    .orderBy(distance)
    .limit(limit);
}

export function createRetrievalRepository(db: Db) {
  return {
    vectorSearch(params: VectorSearchParams): Promise<VectorSearchRow[]> {
      return db.transaction((tx) => nearestChunks(tx, params));
    },
  };
}

export type RetrievalRepository = ReturnType<typeof createRetrievalRepository>;
