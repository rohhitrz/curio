import type { LlmMessage, LlmProvider } from '../../lib/llm/index.js';
import { stripMarkers } from '../retrieval/citations.js';

/** Fixed for every summary call, so OpenAI caches it as the prompt prefix. */
export const CONVERSATION_SUMMARY_INSTRUCTIONS = `You keep a running summary of a study conversation between a learner and Curio, an assistant that answers from the learner's own sources.

You get the summary so far (it may be empty) and the messages that came after it. Write the new summary, which replaces the old one.

Rules:
- Keep what a follow-up question could refer back to: the topics and questions the learner asked about, the main points of the answers, terms that were defined, and anything the learner said they found unclear or wants next.
- Fold the old summary in; drop details that no longer matter, but never contradict it unless a later message does.
- Plain prose or short bullet points, at most about 300 words. No source numbers like [1], no headings, no preamble.
- Write in the language of the conversation.`;

export interface SummaryInput {
  /** The summary so far, if any. */
  previousSummary: string | null;
  /** The messages to fold in, oldest first. */
  messages: LlmMessage[];
}

/** One user message: the old summary, then the new messages as a transcript. */
export function buildSummaryMessages(input: SummaryInput): LlmMessage[] {
  const transcript = input.messages
    .map((message) => {
      const speaker = message.role === 'user' ? 'Learner' : 'Curio';
      const content =
        message.role === 'assistant' ? stripMarkers(message.content) : message.content;
      return `${speaker}: ${content}`;
    })
    .join('\n\n');
  return [
    {
      role: 'user',
      content: `Summary so far:\n${input.previousSummary?.trim() || '(none)'}\n\n---\n\nNew messages:\n\n${transcript}`,
    },
  ];
}

/** The new rolling summary (one Luna call). Failures are `LlmError`s. */
export async function summarizeConversation(
  input: SummaryInput,
  deps: { llm: LlmProvider },
): Promise<string> {
  const result = await deps.llm.generate({
    task: 'conversationSummary',
    instructions: CONVERSATION_SUMMARY_INSTRUCTIONS,
    messages: buildSummaryMessages(input),
  });
  return result.text.trim();
}
