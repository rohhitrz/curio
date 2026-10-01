import { and, cosineDistance, desc, eq, sql } from 'drizzle-orm';
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

/** Chunk columns both searches return. */
const chunkColumns = {
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
};

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
      ...chunkColumns,
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

export interface KeywordSearchParams {
  userId: string;
  notebookId: string;
  query: string;
  limit: number;
}

/**
 * Full-text half of hybrid search (docs/03-database-design.md, "Hybrid search"): chunks whose
 * `search_vector` matches **any** of the query's words, best `ts_rank` first. Words are stemmed
 * and stop words dropped the same way as the indexed text (`english`); OR instead of
 * `plainto_tsquery`'s AND, because a question rarely shares every word with the passage that
 * answers it, and ranking already favors chunks that match more of them. A query of only stop
 * words matches nothing. Same scoping as vector search: the user's notebook, `READY` sources.
 */
export function keywordChunks(
  db: Db | Tx,
  { userId, notebookId, query, limit }: KeywordSearchParams,
) {
  const tsQuery = sql`replace(plainto_tsquery('english', ${query})::text, '&', '|')::tsquery`;
  const rank = sql<number>`ts_rank(${sourceChunks.searchVector}, ${tsQuery})`.mapWith(Number);
  return db
    .select({ ...chunkColumns, textRank: rank })
    .from(sourceChunks)
    .innerJoin(sources, eq(sources.id, sourceChunks.sourceId))
    .where(
      and(
        eq(sourceChunks.notebookId, notebookId),
        eq(sources.userId, userId),
        eq(sources.status, 'READY'),
        sql`${sourceChunks.searchVector} @@ ${tsQuery}`,
      ),
    )
    .orderBy(desc(rank), sourceChunks.id)
    .limit(limit);
}

export type KeywordSearchRow = Awaited<ReturnType<typeof keywordChunks>>[number];

export function createRetrievalRepository(db: Db) {
  return {
    vectorSearch(params: VectorSearchParams): Promise<VectorSearchRow[]> {
      return db.transaction((tx) => nearestChunks(tx, params));
    },
    keywordSearch(params: KeywordSearchParams): Promise<KeywordSearchRow[]> {
      return keywordChunks(db, params);
    },
  };
}

export type RetrievalRepository = ReturnType<typeof createRetrievalRepository>;
