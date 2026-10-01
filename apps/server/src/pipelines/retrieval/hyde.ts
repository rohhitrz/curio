import type { LlmProvider, LlmUsage } from '../../lib/llm/index.js';

/** Fixed for every call (cached prompt prefix); the question goes in the user message. */
export const HYDE_INSTRUCTIONS = `Write a short passage (3-5 sentences) that could appear in a textbook, lecture, documentation page or video transcript and that directly answers the user's question. Write it as the source would, in the language of the question, with the specific terms such a passage would use. No preamble, no hedging, no citations. It is only used to search for real passages; it is never shown.`;

/**
 * HyDE (eval-gated, 6.7): a hypothetical answer passage, embedded for one more vector search.
 * Passages sit closer to passages in embedding space than questions do. Rejects with `LlmError`;
 * the pipeline then skips it.
 */
export async function hypotheticalPassage(
  input: { question: string; abortSignal?: AbortSignal },
  deps: { llm: LlmProvider },
): Promise<{ passage: string; model: string; usage: LlmUsage }> {
  const result = await deps.llm.generate({
    task: 'hyde',
    instructions: HYDE_INSTRUCTIONS,
    messages: [{ role: 'user', content: input.question }],
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  return { passage: result.text.trim(), model: result.model, usage: result.usage };
}
