import { z } from 'zod';
import { retrieval } from '../../config/index.js';
import type { LlmMessage, LlmProvider, LlmUsage } from '../../lib/llm/index.js';
import { stripMarkers } from './citations.js';
import type { QueryUnderstanding } from './pipeline.js';

/**
 * Fixed for every call, so OpenAI caches it as the prompt prefix. The conversation and the
 * question go in the user message.
 */
export const QUERY_UNDERSTANDING_INSTRUCTIONS = `You prepare search queries for a study assistant that answers only from the user's own sources (documents, web pages, videos, notes). You never answer the question yourself.

Given the recent conversation and the user's latest message, return JSON with:
- "needsRetrieval": false only when the latest message needs nothing from the sources: greetings, thanks, acknowledgements, or remarks about the conversation itself ("thanks!", "ok got it", "hi"). Any question or request about a topic, however general, is true. When unsure, true.
- "standaloneQuery": the latest message rewritten so it can be understood without the conversation: replace pronouns and references ("it", "that paper", "the second one") with what they refer to, and keep every exact term, number, name and code as written. If it already stands alone, return it unchanged. Same language as the message.
- "subQueries": only when the message asks about two or more distinct things that would be found in different places (a comparison, "X and Y", several questions in one), one short self-contained search query per thing, at most ${String(retrieval.maxSubQueries)}. Each sub-query is about exactly one of the things and names only that one, never two of them together: for "Compare ridge regression and lasso: how do their penalties differ?" return "ridge regression penalty" and "lasso penalty", not "how do the ridge and lasso penalties differ". Otherwise an empty list.`;

export const queryUnderstandingSchema = z.object({
  needsRetrieval: z.boolean(),
  standaloneQuery: z.string(),
  subQueries: z.array(z.string()),
});

export interface UnderstandQueryInput {
  question: string;
  /** Recent messages, oldest first, without the new question. */
  history: LlmMessage[];
  abortSignal?: AbortSignal;
}

export interface UnderstandQueryResult extends QueryUnderstanding {
  model: string;
  usage: LlmUsage;
}

/** The conversation and the question as one user message, so the model reads it as data. */
export function buildUnderstandingMessage(input: UnderstandQueryInput): LlmMessage {
  const turns = input.history
    .slice(-retrieval.understandingHistoryMessages)
    .map(
      (message) =>
        `${message.role === 'user' ? 'User' : 'Assistant'}: ${
          message.role === 'assistant' ? stripMarkers(message.content) : message.content
        }`,
    );
  const conversation = turns.length > 0 ? turns.join('\n\n') : '(none)';
  return {
    role: 'user',
    content: `Recent conversation:\n${conversation}\n\n---\n\nLatest message: ${input.question}`,
  };
}

/**
 * Step 1 of the chat pipeline (docs/02-system-design.md §7): one Luna call with structured output
 * → routing, the standalone rewrite and sub-queries. Rejects with `LlmError` if the call fails;
 * the pipeline then falls back to the raw question.
 */
export async function understandQuery(
  input: UnderstandQueryInput,
  deps: { llm: LlmProvider },
): Promise<UnderstandQueryResult> {
  const { object, model, usage } = await deps.llm.generateObject(
    {
      task: 'queryUnderstanding',
      instructions: QUERY_UNDERSTANDING_INSTRUCTIONS,
      messages: [buildUnderstandingMessage(input)],
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    },
    queryUnderstandingSchema,
  );
  return {
    needsRetrieval: object.needsRetrieval,
    standaloneQuery: object.standaloneQuery.trim(),
    subQueries: object.subQueries
      .map((query) => query.trim())
      .filter(Boolean)
      .slice(0, retrieval.maxSubQueries),
    model,
    usage,
  };
}
