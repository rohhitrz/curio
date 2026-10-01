export interface RerankRequest {
  query: string;
  documents: string[];
  /** Results returned, at most. */
  topN: number;
}

export interface RerankResult {
  /** Most relevant first. */
  results: { index: number; score: number }[];
  model: string;
  /** What the call was billed (Cohere: search units), for the eval's cost line. */
  searchUnits: number;
}

/** Reorders documents by relevance to the query. Failures are `RerankError`s. */
export interface RerankProvider {
  readonly model: string;
  rerank(request: RerankRequest): Promise<RerankResult>;
}
