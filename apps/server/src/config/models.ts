/**
 * Model per task (docs/02-system-design.md §2, decision A-08).
 * Luna by default; a task moves to Sol only if evals show the need.
 */
export type LlmTier = 'luna' | 'sol';

/** OpenAI API model IDs (checked against the account's model list, 2026-10-01). */
export const llmModels = {
  luna: 'gpt-6-luna',
  sol: 'gpt-6.1-sol',
} as const satisfies Record<LlmTier, string>;

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface LlmTaskConfig {
  tier: LlmTier;
  /** Caps the answer, including reasoning tokens. */
  maxOutputTokens: number;
  reasoningEffort: ReasoningEffort;
}

export const llmTasks = {
  queryUnderstanding: { tier: 'luna', maxOutputTokens: 1_000, reasoningEffort: 'none' },
  chatAnswer: { tier: 'luna', maxOutputTokens: 4_000, reasoningEffort: 'low' },
  /** A message routed past retrieval ("thanks!"): a short reply, no sources. */
  chatReply: { tier: 'luna', maxOutputTokens: 300, reasoningEffort: 'none' },
  conversationSummary: { tier: 'luna', maxOutputTokens: 2_000, reasoningEffort: 'low' },
  memoryExtraction: { tier: 'luna', maxOutputTokens: 2_000, reasoningEffort: 'low' },
  learningPath: { tier: 'luna', maxOutputTokens: 8_000, reasoningEffort: 'medium' },
  lesson: { tier: 'luna', maxOutputTokens: 8_000, reasoningEffort: 'medium' },
  evalJudge: { tier: 'sol', maxOutputTokens: 4_000, reasoningEffort: 'medium' },
} as const satisfies Record<string, LlmTaskConfig>;

export type LlmTask = keyof typeof llmTasks;

export const embeddings = {
  model: 'text-embedding-3-small',
  dimensions: 1536,
} as const;
