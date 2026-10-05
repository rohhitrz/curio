import type { RerankProvider } from '../../lib/rerank/index.js';
import type { RetrievedChunk } from './retrieve.js';

/** What the reranker reads for a chunk: the same text ingestion embeds. */
export const rerankDocument = (chunk: Pick<RetrievedChunk, 'contextHeader' | 'content'>) =>
  `${chunk.contextHeader}\n\n${chunk.content}`;

/**
 * Step 4 of the chat pipeline (docs/02-system-design.md §7): the reranker reads the query and
 * each candidate together and keeps the `topK` most relevant, best first. Each chunk's `score`
 * becomes the reranker's relevance (0–1), which the relevance gate (6.5) can threshold; fused
 * RRF scores can't be. Rejects with `RerankError`; the pipeline then keeps the fused order.
 */
export async function rerankChunks(
  input: { query: string; chunks: RetrievedChunk[]; topK: number },
  deps: { reranker: RerankProvider; onSearchUnits?: (units: number) => void },
): Promise<RetrievedChunk[]> {
  if (input.chunks.length === 0) return [];
  const { results, searchUnits } = await deps.reranker.rerank({
    query: input.query,
    documents: input.chunks.map(rerankDocument),
    topN: input.topK,
  });
  deps.onSearchUnits?.(searchUnits);
  return results.flatMap(({ index, score }, position) => {
    const chunk = input.chunks[index];
    return chunk ? [{ ...chunk, rank: position + 1, score }] : [];
  });
}

/**
 * A question with sub-queries is reranked once per query (R-11): the whole question first, then
 * each part. Merged in turns (every list's #1, then every #2, …) so each part reaches the answer
 * even when another part scores higher everywhere; a chunk in several lists stays at its first
 * place with its best score. Cut to `topK`, ranks 1…n. One list comes back unchanged.
 */
export function mergeRerankedLists(lists: RetrievedChunk[][], topK: number): RetrievedChunk[] {
  const merged = new Map<string, RetrievedChunk>();
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let position = 0; position < longest; position += 1) {
    for (const list of lists) {
      const chunk = list[position];
      if (!chunk) continue;
      const seen = merged.get(chunk.chunkId);
      if (!seen) merged.set(chunk.chunkId, chunk);
      else if (chunk.score > seen.score) merged.set(chunk.chunkId, { ...seen, score: chunk.score });
    }
  }
  return [...merged.values()].slice(0, topK).map((chunk, index) => ({ ...chunk, rank: index + 1 }));
}
