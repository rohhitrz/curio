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
  /** HyDE's hypothetical passage (eval-gated, 6.7). */
  hyde: { tier: 'luna', maxOutputTokens: 400, reasoningEffort: 'none' },
  /** A message routed past retrieval ("thanks!"): a short reply, no sources. */
  chatReply: { tier: 'luna', maxOutputTokens: 300, reasoningEffort: 'none' },
  conversationSummary: { tier: 'luna', maxOutputTokens: 2_000, reasoningEffort: 'low' },
  memoryExtraction: { tier: 'luna', maxOutputTokens: 2_000, reasoningEffort: 'low' },
  /** Judges search results for a learning path (relevant? official? how authoritative?). */
  resourceSelection: { tier: 'luna', maxOutputTokens: 2_000, reasoningEffort: 'low' },
  /** Concepts one resource covers (map, one call per resource). */
  conceptMap: { tier: 'luna', maxOutputTokens: 5_000, reasoningEffort: 'low' },
  /** The topic's core concepts from the model's own knowledge (L-09). */
  conceptRecall: { tier: 'luna', maxOutputTokens: 3_000, reasoningEffort: 'low' },
  /** Groups the same concept named differently across resources. */
  conceptMerge: { tier: 'luna', maxOutputTokens: 8_000, reasoningEffort: 'low' },
  /** Prerequisite order, modules, gaps and advanced branches. */
  learningPath: { tier: 'luna', maxOutputTokens: 8_000, reasoningEffort: 'medium' },
  /** Is the topic too broad for one path? If so, narrower topics (L-11). */
  pathScope: { tier: 'luna', maxOutputTokens: 1_000, reasoningEffort: 'low' },
  /** The path's hook: what / why / example / origin. */
  pathHook: { tier: 'luna', maxOutputTokens: 1_000, reasoningEffort: 'low' },
  lesson: { tier: 'luna', maxOutputTokens: 8_000, reasoningEffort: 'medium' },
  /** Luna, not Sol (owner, 2026-10-01: Luna is enough; decision O-04). */
  evalJudge: { tier: 'luna', maxOutputTokens: 4_000, reasoningEffort: 'medium' },
} as const satisfies Record<string, LlmTaskConfig>;

export type LlmTask = keyof typeof llmTasks;

/**
 * Cohere rerank model (step 4 of retrieval). Fast, picked by eval in 6.4: same retrieval as pro
 * (MRR 0.983), answers within noise, ~35% faster and 20% cheaper (decision R-04).
 */
export const rerankModels = {
  default: 'rerank-v4.0-fast',
  /** The models the eval compares. */
  candidates: ['rerank-v4.0-pro', 'rerank-v4.0-fast'],
} as const;

export const embeddings = {
  model: 'text-embedding-3-small',
  dimensions: 1536,
} as const;
