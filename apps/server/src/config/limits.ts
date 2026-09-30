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
  fusionCandidates: 40,
  rerankTopK: 8,
} as const;

export const conversation = {
  recentMessages: 10,
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
  /** A transcript the vendor prepares in the background is polled this often, this many times. */
  transcriptJobPollIntervalMs: 3_000,
  transcriptJobPollAttempts: 10,
} as const;

export const requests = {
  /** JSON body cap. Pasted text can be 100k chars, which is up to ~400 KB of UTF-8. */
  jsonBodyLimit: '1mb',
  /** Inngest sends a run's step results back with each call, so its endpoint gets more room. */
  inngestBodyLimit: '4mb',
} as const;
