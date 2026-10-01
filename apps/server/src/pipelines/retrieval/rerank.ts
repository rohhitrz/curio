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
