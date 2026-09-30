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
  resultsDir: fileURLToPath(new URL('../results/', import.meta.url)),
} as const;

export const maxK = Math.max(...evalConfig.hitRateKs);
