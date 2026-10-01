import type { LlmMessage } from '../../lib/llm/index.js';
import { stripMarkers } from './citations.js';

/** What the user sees when the sources don't hold the answer (PRD §5.5: never invent one). */
export const NOT_IN_SOURCES_ANSWER =
  "I couldn't find this in your sources. Try rephrasing the question, or add a source that covers it.";

/**
 * Fixed for every chat answer, so OpenAI caches it as the prompt prefix. Nothing request-specific
 * belongs here: sources and the question go in the last message.
 */
export const CHAT_ANSWER_INSTRUCTIONS = `You are Curio, a study assistant. You answer questions using only the numbered sources in the user's latest message.

Rules:
- Use only facts stated in the sources. Your own knowledge may only connect and explain those facts; it is never a source of facts.
- Cite every factual claim with the number of its source in square brackets, right after the claim: [1]. For several sources write [1][3]. Only use numbers that appear in the sources.
- If the sources don't answer the question, reply with exactly this sentence and nothing else: "${NOT_IN_SOURCES_ANSWER}"
- If the sources answer only part of the question, answer that part with citations and say which part they don't cover.
- Earlier messages are context for follow-up questions only; their facts must still come from the current sources.
- Write clearly for a learner: lead with the direct answer, then explain. Use short paragraphs, and lists when they help. Use Markdown.
- Answer in the language of the question.`;

/**
 * For a message routed past retrieval ("thanks!", "hi"). Fixed text, cached like the answer's.
 * It still must not answer from its own knowledge: routing can be wrong.
 */
export const CHAT_REPLY_INSTRUCTIONS = `You are Curio, a study assistant that answers questions from the user's own sources. The user's latest message is small talk (a greeting, thanks, an acknowledgement), so no sources were searched.

Rules:
- Reply in one or two short, friendly sentences, in the language of the message.
- Do not state any facts and do not answer questions about any topic. If the message does ask something, say you can answer it from their sources and ask them to phrase it as a question.`;

/** Earlier turns (old `[n]` markers removed) then the new message, for the no-sources reply. */
export function buildReplyMessages(input: { question: string; history: LlmMessage[] }) {
  return [...cleanHistory(input.history), { role: 'user' as const, content: input.question }];
}

function cleanHistory(history: LlmMessage[]): LlmMessage[] {
  return history.map((message) => ({
    role: message.role,
    content: message.role === 'assistant' ? stripMarkers(message.content) : message.content,
  }));
}

export interface ChatPromptInput {
  question: string;
  /** Numbered sources (`buildContext`). */
  contextText: string;
  /** Rolling summary of older messages (Phase 7), if any. */
  summary?: string | null;
  /** Recent messages, oldest first, without the new question. */
  history: LlmMessage[];
}

/**
 * Messages after the static instructions: summary, earlier turns, then the sources and the
 * question. Old answers lose their `[n]` markers, which pointed at sources that aren't in this
 * prompt.
 */
export function buildChatMessages(input: ChatPromptInput): LlmMessage[] {
  const messages: LlmMessage[] = [];
  if (input.summary) {
    messages.push(
      { role: 'user', content: `Summary of our earlier conversation:\n${input.summary}` },
      { role: 'assistant', content: 'Understood.' },
    );
  }
  messages.push(...cleanHistory(input.history));
  messages.push({
    role: 'user',
    content: `Sources:\n\n${input.contextText}\n\n---\n\nQuestion: ${input.question}`,
  });
  return messages;
}
