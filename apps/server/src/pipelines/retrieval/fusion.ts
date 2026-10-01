import type { RetrievedChunk } from './retrieve.js';

/**
 * Reciprocal Rank Fusion (R-03): each chunk scores Σ 1 / (k + rank) over the lists it appears in,
 * so only ranks matter, never the lists' own scores (cosine and keyword scores aren't comparable).
 * Returns the top `limit` chunks, best first, with the fused score; ties keep first-seen order.
 */
export function fuseRankLists(
  lists: RetrievedChunk[][],
  options: { k: number; limit: number },
): RetrievedChunk[] {
  const fused = new Map<string, { chunk: RetrievedChunk; score: number; order: number }>();
  for (const list of lists) {
    list.forEach((chunk, index) => {
      const contribution = 1 / (options.k + index + 1);
      const entry = fused.get(chunk.chunkId);
      if (entry) entry.score += contribution;
      else fused.set(chunk.chunkId, { chunk, score: contribution, order: fused.size });
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, options.limit)
    .map(({ chunk, score }, index) => ({ ...chunk, rank: index + 1, score }));
}
