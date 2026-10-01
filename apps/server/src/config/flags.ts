/**
 * Retrieval feature flags (docs/02-system-design.md §7). Required for eval ablations.
 * Off until each technique is built in Phase 6; turned on as evals prove a gain (R-07).
 *
 * - `queryRewrite` on since 6.2: follow-up MRR 0.54 → 0.73, follow-up correctness 3.5 → 4.6
 *   (`evals/results/2026-10-01-vector+queryRewrite.json`).
 */
export interface RetrievalFlags {
  queryRewrite: boolean;
  hybridSearch: boolean;
  rerank: boolean;
  subQueries: boolean;
  hyde: boolean;
}

export const retrievalFlags: RetrievalFlags = {
  queryRewrite: true,
  hybridSearch: false,
  rerank: false,
  subQueries: false,
  hyde: false,
};
