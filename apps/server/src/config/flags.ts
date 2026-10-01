/**
 * Retrieval feature flags (docs/02-system-design.md §7). Required for eval ablations.
 * Off until each technique is built in Phase 6; turned on as evals prove a gain (R-07).
 *
 * - `queryRewrite` on since 6.2: follow-up MRR 0.54 → 0.73, follow-up correctness 3.5 → 4.7
 *   (`evals/results/2026-10-01-vector+queryRewrite.json`).
 * - `hybridSearch` on since 6.3: MRR 0.81 → 0.85, correctness ≥ 4 0.88 → 0.97, multi-part
 *   correctness 3.0 → 3.75 (`evals/results/2026-10-01-vector+queryRewrite+hybridSearch.json`).
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
  hybridSearch: true,
  rerank: false,
  subQueries: false,
  hyde: false,
};
