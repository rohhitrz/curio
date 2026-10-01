/** Quotas, rate limits, and pipeline sizes (docs/02-system-design.md §7, §10, §14). */

export const quotas = {
  pdfMaxBytes: 25 * 1024 * 1024,
  youtubeMaxSeconds: 3 * 60 * 60,
  textMaxChars: 100_000,
  sourcesPerNotebook: 50,
  notebooksPerUser: 30,
  memoriesPerUser: 200,
} as const;

/** Per user, enforced with Upstash Redis. `windowSeconds` is the sliding window. */
export const rateLimits = {
  chatMessages: [
    { limit: 20, windowSeconds: 60 },
    { limit: 200, windowSeconds: 24 * 60 * 60 },
  ],
  lessonGenerations: [{ limit: 50, windowSeconds: 24 * 60 * 60 }],
  learningPaths: [{ limit: 5, windowSeconds: 24 * 60 * 60 }],
  sourceAdds: [{ limit: 50, windowSeconds: 24 * 60 * 60 }],
} as const;

export const locks = {
  conversationTtlSeconds: 120,
  lessonTtlSeconds: 120,
} as const;

export const chunking = {
  targetTokens: 500,
  overlapRatio: 0.15,
} as const;

export const retrieval = {
  /** Chunks vector search returns: the candidate pool that fusion and rerank start from. */
  vectorCandidates: 40,
  /** Chunks keyword search returns, fused with the vector results (hybrid search). */
  keywordCandidates: 40,
  fusionCandidates: 40,
  /** RRF's k: 60 is the value from the original paper and the common default. */
  rrfK: 60,
  /** Sub-queries searched besides the main query, at most. */
  maxSubQueries: 3,
  /** Recent messages the query-understanding call sees to resolve follow-ups. */
  understandingHistoryMessages: 6,
  rerankTopK: 8,
  /**
   * pgvector keeps scanning the HNSW index until enough chunks pass the notebook filter
   * (docs/03-database-design.md). Without it, a notebook whose chunks aren't among the index's
   * first `hnsw.ef_search` (40) nearest across all notebooks gets few or no results.
   * `strict_order` keeps results exactly ordered by distance.
   */
  hnswIterativeScan: 'strict_order',
  /**
   * Relevance gate (step 5): a top rerank score below this → "not in your sources" without a
   * model call. Tuned in 6.5 on the eval's unanswerable questions (`gateSweep` in the results).
   */
  relevanceThreshold: 0.7,
  /** Numbered sources sent to the model, at most (tokens, counted like the embeddings). */
  contextMaxTokens: 6_000,
} as const;

export const citations = {
  /** Passage kept in a citation snapshot: enough to show, survives the source's deletion. */
  snippetMaxChars: 300,
} as const;

export const conversation = {
  /** Earlier messages sent with each question (docs/02-system-design.md §10). */
  recentMessages: 10,
  /** A new conversation is named after its first question, cut to about this length. */
  autoTitleMaxChars: 80,
  /**
   * After an answer, more than this many messages missing from the summary → the summary job
   * runs (docs/04-api-design.md §5, step 10). It summarizes all but the last `recentMessages`,
   * which the prompt already carries word for word.
   */
  summarizeAfterMessages: 20,
  /** Retries of the summary job; a failed run is caught up by the next answer's event. */
  summaryJobRetries: 2,
} as const;

export const uploads = {
  pdfContentType: 'application/pdf',
  /** Signed PUT URL lifetime (API doc: 10 min). */
  uploadUrlTtlSeconds: 10 * 60,
  /** Signed GET URL lifetime for the PDF viewer. */
  downloadUrlTtlSeconds: 5 * 60,
} as const;

/** Timeouts for the services that read sources (docs/02-system-design.md §6). */
export const extraction = {
  /** Whole Firecrawl call; slow sites are retried by the job rather than waited on. */
  scrapeTimeoutMs: 60_000,
  /** Each transcript-service call. */
  transcriptTimeoutMs: 30_000,
  /**
   * Caption language asked for first. Without it a video with auto-translated tracks could come
   * back in any of them (seen: an English video ingested as Arabic).
   */
  transcriptLanguage: 'en',
  /** A transcript the vendor prepares in the background is polled this often, this many times. */
  transcriptJobPollIntervalMs: 3_000,
  transcriptJobPollAttempts: 10,
} as const;

/** The `processSource` job (docs/02-system-design.md §6). */
export const ingestion = {
  /** Retries of a step after its first attempt, with Inngest's backoff. */
  retries: 3,
  /** Sources processed at the same time: in total, and for one user. */
  concurrency: 5,
  concurrencyPerUser: 2,
  /** Runs started per minute in total, which keeps us under the vendors' rate limits. */
  throttle: { limit: 30, period: '1m' },
  /** Chunk rows per INSERT inside the commit transaction. */
  chunkInsertBatchSize: 100,
  /** How often the sweeper runs. */
  sweepCron: '*/5 * * * *',
  /** A source still `PROCESSING` after this long is failed with `TIMEOUT`. */
  processingTimeoutMinutes: 15,
  /** A source still `PENDING` after this long never got a job run: its event is sent again. */
  pendingResendMinutes: 10,
  /** Stale `PENDING` sources re-sent per sweep. */
  sweepBatchSize: 100,
} as const;

export const embeddingRequests = {
  /** Texts per embeddings call (the API allows far more; smaller calls retry cheaply). */
  batchSize: 100,
  timeoutMs: 30_000,
} as const;

/**
 * Chat-path deadlines (6.8, latency budget in docs/02-system-design.md §7: ~3s to first token).
 * An optional step past its deadline is skipped; a required one fails the answer.
 */
export const chatTimeouts = {
  /** Query understanding (optional): past this, the raw question is searched. */
  understandMs: 3_000,
  /** HyDE (optional): past this, it is skipped. */
  hydeMs: 3_000,
  /** Embedding the question (one short text). */
  queryEmbeddingMs: 5_000,
  /** Each search query in Postgres (`statement_timeout`); a failed search leaves the other one. */
  searchStatementMs: 5_000,
} as const;

/** Clients outside the chat pipeline that had no timeout of their own. */
export const serviceTimeouts = {
  /** Each Upstash request (lock, rate limit); failures are already handled (503 / allowed). */
  redisMs: 2_000,
  /** R2: connecting, and each request (signed URLs need none; deletes and reads do). */
  storageConnectMs: 5_000,
  storageRequestMs: 15_000,
} as const;

export const rerankRequests = {
  /**
   * Whole call. The latency budget gives rerank ~0.3–0.5s; past this, chat answers from the
   * fused order instead of waiting.
   */
  timeoutMs: 3_000,
  /** Cohere cuts longer documents; a chunk is ~500 tokens plus its header. */
  maxTokensPerDoc: 1_024,
} as const;

export const llmRequests = {
  /** Whole call, including streaming. The chat's first-token budget is ~3s; this is the hard stop. */
  timeoutMs: 90_000,
  /** Retries of a failed call (rate limit, 5xx) with the SDK's backoff; never mid-stream. */
  maxRetries: 2,
} as const;

/** Langfuse traces (docs/02-system-design.md §12). */
export const tracing = {
  /** Chunk text and prompts are cut to this many characters: no full source content in traces. */
  maxTextChars: 500,
} as const;

export const requests = {
  /** JSON body cap. Pasted text can be 100k chars, which is up to ~400 KB of UTF-8. */
  jsonBodyLimit: '1mb',
  /** Inngest sends a run's step results back with each call, so its endpoint gets more room. */
  inngestBodyLimit: '4mb',
} as const;
