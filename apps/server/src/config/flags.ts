/**
 * Retrieval feature flags (docs/02-system-design.md §7). Required for eval ablations.
 * Off until each technique is built in Phase 6; turned on as evals prove a gain.
 */
export interface RetrievalFlags {
  queryRewrite: boolean;
  hybridSearch: boolean;
  rerank: boolean;
  subQueries: boolean;
  hyde: boolean;
}

export const retrievalFlags: RetrievalFlags = {
  queryRewrite: false,
  hybridSearch: false,
  rerank: false,
  subQueries: false,
  hyde: false,
};
