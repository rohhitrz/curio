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
   * USD per 1M tokens, by API model ID (OpenAI list prices, checked 2026-10-01). Used only to
   * report what a run cost; an unknown model fails the run so the cost is never silently wrong.
   */
  llmPrices: {
    'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
    'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10 },
  } as Record<string, { input: number; cachedInput: number; output: number }>,
  resultsDir: fileURLToPath(new URL('../results/', import.meta.url)),
} as const;

export const maxK = Math.max(...evalConfig.hitRateKs);
