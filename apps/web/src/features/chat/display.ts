import type { CitationSnapshot, Feedback, Message } from '@curio/shared';
import type { PendingTurn } from './use-answer-stream';

export type ChatItem =
  | { kind: 'question'; key: string; content: string }
  | {
      kind: 'answer';
      key: string;
      /** Saved message ID; null while streaming. */
      messageId: string | null;
      text: string;
      citations: CitationSnapshot[];
      status: string | null;
      streaming: boolean;
      error: string | null;
      feedback: Feedback | null;
      /** A failed or missing answer at the end of the conversation can be retried. */
      retryable: boolean;
    };

const FAILED_ANSWER = 'This answer failed.';
const NO_ANSWER = 'This question has no answer yet.';

/**
 * Saved messages (oldest first) plus the turn that is streaming, if it belongs to this
 * conversation. A question already saved isn't shown twice; a retried answer replaces the failed
 * one it is regenerating. A last question with no answer (the server stopped mid-way) gets a
 * failed answer that can be retried.
 */
export function buildChatItems(
  messages: Message[],
  pending: PendingTurn | null,
  conversationId: string | null,
): ChatItem[] {
  const turn = pending && pending.conversationId === conversationId ? pending : null;
  // A retry regenerates the last (failed) answer: hide it while the new one streams.
  const saved =
    turn && turn.question === null && messages.at(-1)?.role === 'ASSISTANT'
      ? messages.slice(0, -1)
      : messages;

  const items: ChatItem[] = saved.map((message, index) =>
    message.role === 'USER'
      ? { kind: 'question', key: message.id, content: message.content }
      : {
          kind: 'answer',
          key: message.id,
          messageId: message.id,
          text: message.content,
          citations: message.citations,
          status: null,
          streaming: false,
          error: message.status === 'ERROR' ? FAILED_ANSWER : null,
          feedback: message.feedback,
          retryable: message.status === 'ERROR' && index === saved.length - 1 && !turn,
        },
  );

  const last = saved.at(-1);
  if (!turn && last?.role === 'USER') {
    items.push({
      kind: 'answer',
      key: `unanswered-${last.id}`,
      messageId: null,
      text: '',
      citations: [],
      status: null,
      streaming: false,
      error: NO_ANSWER,
      feedback: null,
      retryable: true,
    });
  }

  if (turn) {
    if (turn.question && !saved.some((m) => m.id === turn.question?.id)) {
      items.push({ kind: 'question', key: turn.question.id, content: turn.question.content });
    }
    items.push({
      kind: 'answer',
      key: 'pending',
      messageId: null,
      text: turn.answer.text,
      citations: turn.answer.citations,
      status: turn.answer.status,
      streaming: !turn.answer.done && !turn.answer.error,
      error: turn.answer.error?.message ?? null,
      feedback: null,
      retryable: false,
    });
  }
  return items;
}

/**
 * Whether the turn's answer is among the saved messages (oldest first): the streamed answer's ID,
 * or for a new question any answer right after it.
 */
export function isAnswerSaved(messages: Message[], turn: PendingTurn): boolean {
  const { messageId } = turn.answer;
  if (messageId && messages.some((m) => m.id === messageId)) return true;
  const questionId = turn.question?.id;
  if (!questionId) return false;
  const index = messages.findIndex((m) => m.id === questionId);
  return index !== -1 && messages[index + 1]?.role === 'ASSISTANT';
}
