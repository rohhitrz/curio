/**
 * Model per task (docs/02-system-design.md §2, decision A-08).
 * Luna by default; a task moves to Sol only if evals show the need.
 * Exact API model IDs are set and verified when the LLM provider is built (step 5.2).
 */
export type LlmTier = 'luna' | 'sol';

export const llmTasks = {
  queryUnderstanding: 'luna',
  chatAnswer: 'luna',
  conversationSummary: 'luna',
  memoryExtraction: 'luna',
  learningPath: 'luna',
  lesson: 'luna',
  evalJudge: 'sol',
} as const satisfies Record<string, LlmTier>;

export type LlmTask = keyof typeof llmTasks;

export const embeddings = {
  model: 'text-embedding-3-small',
  dimensions: 1536,
} as const;
