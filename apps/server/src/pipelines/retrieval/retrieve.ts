import type { SourceType } from '@curio/shared';
import { retrieval } from '../../config/index.js';
import type { EmbeddingsProvider } from '../../lib/embeddings/index.js';

/** One chunk as vector search returns it (see `retrieval.repository.ts`). */
export interface ChunkMatch {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: SourceType;
  chunkIndex: number;
  content: string;
  contextHeader: string;
  pageNumber: number | null;
  startSeconds: number | null;
  endSeconds: number | null;
  headingPath: string | null;
  charStart: number | null;
  charEnd: number | null;
  /** Cosine distance: 0 = same direction, 2 = opposite. */
  distance: number;
}

/** One chunk as keyword search returns it: no distance, a full-text rank instead. */
export interface KeywordMatch extends Omit<ChunkMatch, 'distance'> {
  /** Postgres `ts_rank`: higher matches more of the query; not comparable to cosine scores. */
  textRank: number;
}

export interface RetrievalDeps {
  embeddings: EmbeddingsProvider;
  /** Nearest chunks first, scoped to the user's notebook and to `READY` sources. */
  vectorSearch(params: {
    userId: string;
    notebookId: string;
    embedding: number[];
    limit: number;
  }): Promise<ChunkMatch[]>;
}

export interface RetrieveInput {
  userId: string;
  notebookId: string;
  query: string;
  /** Defaults to `retrieval.vectorCandidates`. */
  limit?: number;
}

/** Where a chunk sits in its source, for citations and for eval relevance matching. */
export interface ChunkLocation {
  pageNumber: number | null;
  startSeconds: number | null;
  endSeconds: number | null;
  headingPath: string | null;
  charStart: number | null;
  charEnd: number | null;
}

export interface RetrievedChunk {
  /** 1-based position in the results. */
  rank: number;
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: SourceType;
  chunkIndex: number;
  content: string;
  contextHeader: string;
  location: ChunkLocation;
  /** Cosine similarity (1 − distance): higher is closer. */
  score: number;
}

/**
 * Retrieval v0: vector-only search over one notebook (build plan 4.1). Embeds the query and
 * returns the nearest chunks, best first. Callable without HTTP (the eval runner uses it directly);
 * the embeddings provider and the search are injected.
 *
 * A blank query returns nothing without calling the embeddings API.
 */
export async function retrieve(
  input: RetrieveInput,
  deps: RetrievalDeps,
): Promise<RetrievedChunk[]> {
  const query = input.query.trim();
  const limit = input.limit ?? retrieval.vectorCandidates;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, got ${String(limit)}`);
  }
  if (query === '') return [];

  const [embedding] = await deps.embeddings.embed([query]);
  if (!embedding) throw new Error('The embeddings provider returned no vector for the query');

  const matches = await deps.vectorSearch({
    userId: input.userId,
    notebookId: input.notebookId,
    embedding,
    limit,
  });
  return matches.map((match, index) => toRetrievedChunk(match, index + 1, 1 - match.distance));
}

/** A search row as a ranked chunk; `score` is whatever the search ranks by. */
export function toRetrievedChunk(
  match: Omit<ChunkMatch, 'distance'>,
  rank: number,
  score: number,
): RetrievedChunk {
  return {
    rank,
    chunkId: match.chunkId,
    sourceId: match.sourceId,
    sourceTitle: match.sourceTitle,
    sourceType: match.sourceType,
    chunkIndex: match.chunkIndex,
    content: match.content,
    contextHeader: match.contextHeader,
    location: {
      pageNumber: match.pageNumber,
      startSeconds: match.startSeconds,
      endSeconds: match.endSeconds,
      headingPath: match.headingPath,
      charStart: match.charStart,
      charEnd: match.charEnd,
    },
    score,
  };
}
