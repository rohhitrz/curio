import { fileURLToPath } from 'node:url';

/**
 * Eval-run settings (test plan §6). App limits, models and flags stay in
 * `apps/server/src/config/`; the runner reads those directly so it measures the real pipeline.
 */
export const evalConfig = {
  /** Cut-offs for hit rate@k; the largest is also how many chunks are retrieved per question. */
  hitRateKs: [5, 10],
  /** The eval notebook's owner in the dev database (`users.clerk_user_id`). */
  evalUserClerkId: 'eval_runner',
  notebookTitle: 'Eval: golden dataset',
  /** USD per 1M tokens for the embedding model (OpenAI list price for text-embedding-3-small). */
  embeddingUsdPerMillionTokens: 0.02,
  /** Answer metrics are averaged over this many runs, since LLM outputs vary (test plan §6.5). */
  answerRuns: 2,
  /** Questions answered and judged at the same time. */
  answerConcurrency: 4,
  /**
   * Attempts per question when a call fails with a retryable error (timeout, 5xx) after the
   * provider's own retries, so one slow call doesn't lose the whole run.
   */
  questionAttempts: 3,
  /**
   * USD per 1M tokens, by API model ID (OpenAI list prices, checked 2026-10-01). Used only to
   * report what a run cost; an unknown model fails the run so the cost is never silently wrong.
   */
  llmPrices: {
    'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
    'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10 },
  } as Record<string, { input: number; cachedInput: number; output: number }>,
  /**
   * USD per 1,000 Cohere search units, by rerank model (third-party listing of Cohere's prices,
   * checked 2026-10-01; Cohere bills search units, which each response reports).
   */
  rerankPricesPerThousandSearches: {
    'rerank-v4.0-pro': 2.5,
    'rerank-v4.0-fast': 2,
  } as Record<string, number>,
  /**
   * Rerank timeout in the eval. Longer than chat's (`rerankRequests.timeoutMs`): the eval measures
   * quality, and records each call's latency so the models can be compared on speed too.
   */
  rerankTimeoutMs: 15_000,
  /**
   * Rerank calls per minute, at most. Cohere Trial keys allow 10; going over makes calls fail
   * with 429, and the pipeline then silently keeps the fused order, which skews the comparison.
   */
  rerankCallsPerMinute: 10,
  /** Learning-path eval (8.7): its own owner, so it never touches the RAG eval's notebook. */
  pathEvalUserClerkId: 'eval_path_runner',
  /** Builds per topic and level for consistency (test plan §6.3: 3 runs, same topic + level). */
  pathRuns: 3,
  /** Levels measured for coverage + consistency; advanced is built once per topic (end to end). */
  pathLevels: ['BEGINNER', 'INTERMEDIATE'] as const,
  /** Two concept names this similar (embedding cosine) count as the same concept across runs. */
  conceptMatchThreshold: 0.85,
  /** Resources mapped at the same time (one Luna call each). */
  mapConcurrency: 3,
  /** Lesson eval (9.7): lessons written per topic, from the path's first modules. */
  lessonModules: 3,
  resultsDir: fileURLToPath(new URL('../results/', import.meta.url)),
} as const;

export const maxK = Math.max(...evalConfig.hitRateKs);
