export interface SearchRequest {
  query: string;
  /** Results returned, at most. */
  maxResults: number;
  /** Only these sites (e.g. a topic's official docs). */
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  /** The search engine's excerpt of the page, not the page itself. */
  snippet: string;
  /** Relevance to the query, 0–1, as the engine scores it. */
  score: number;
}

/** Finds web pages for a query; reading them is the scraper's job. Failures are `SearchError`s. */
export interface SearchProvider {
  search(request: SearchRequest): Promise<SearchResult[]>;
}
