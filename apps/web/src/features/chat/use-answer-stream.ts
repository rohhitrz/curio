'use client';

import { messageListSchema } from '@curio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '@/app/providers';
import { isApiError, type ApiError } from '@/lib/api';
import { isAnswerSaved } from './display';
import { chatKeys } from './queries';
import { applyChunk, emptyAnswer, readChatStream, type AnswerState } from './stream';

/** A little longer than the server's conversation lock (~2 min), which ends a crashed run. */
const WAIT_FOR_SAVED_ANSWER_MS = 150_000;
const POLL_MS = 3_000;
const CONNECTION_LOST = 'The connection was lost. Waiting for the answer to be saved…';

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** A question and its answer while it streams, before the saved messages are reloaded. */
export interface PendingTurn {
  conversationId: string;
  /** Null for a retry (the question is already in the conversation). */
  question: { id: string; content: string } | null;
  answer: AnswerState;
}

/**
 * Sends a question (or retries a failed answer) and follows the streamed answer. Only the new
 * message goes to the server; it builds the history itself. Once the stream ends the
 * conversation's messages are reloaded and the pending turn is dropped.
 */
export function useAnswerStream(notebookId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page stops reading; the server still finishes and saves the answer.
  useEffect(() => () => abortRef.current?.abort(), []);

  /** Polls the newest messages until the turn's answer is saved, or the wait runs out. */
  async function waitForSavedAnswer(turn: PendingTurn, signal: AbortSignal) {
    const deadline = Date.now() + WAIT_FOR_SAVED_ANSWER_MS;
    while (!signal.aborted && Date.now() < deadline) {
      await sleep(POLL_MS, signal);
      try {
        const page = await api.get(`/conversations/${turn.conversationId}/messages`, {
          schema: messageListSchema,
          query: { limit: 10 },
          signal,
        });
        if (isAnswerSaved([...page.items].reverse(), turn)) return;
      } catch {
        // Still offline: keep waiting.
      }
    }
  }

  async function run(
    conversationId: string,
    path: string,
    body: unknown,
    question: PendingTurn['question'],
  ) {
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setPending({ conversationId, question, answer: emptyAnswer });
    let answer = emptyAnswer;
    try {
      const stream = await api.stream(path, body, { signal: controller.signal });
      for await (const chunk of readChatStream(stream)) {
        answer = applyChunk(answer, chunk);
        const current = answer;
        setPending((turn) => (turn ? { ...turn, answer: current } : turn));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (isApiError(err)) setError(err);
      else {
        // The connection dropped mid-answer; the server keeps going. Keep the turn (and this
        // message) on screen until the answer is saved; if it never is, the question is left
        // unanswered and offers Retry.
        const turn: PendingTurn = {
          conversationId,
          question,
          answer: {
            ...answer,
            status: null,
            error: { code: 'INTERNAL_ERROR', message: CONNECTION_LOST },
          },
        };
        setPending(turn);
        await waitForSavedAnswer(turn, controller.signal);
      }
    } finally {
      if (!controller.signal.aborted) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: chatKeys.messages(conversationId) }),
          // The title and the order change after an answer.
          queryClient.invalidateQueries({ queryKey: chatKeys.conversations(notebookId) }),
        ]);
        setPending(null);
      }
    }
  }

  return {
    pending,
    /** Refused before streaming (busy, rate limited, not found…). */
    error,
    isStreaming: pending !== null,
    clearError: () => setError(null),
    send: (conversationId: string, content: string) => {
      const question = { id: crypto.randomUUID(), content };
      return run(conversationId, `/conversations/${conversationId}/messages`, question, question);
    },
    retry: (conversationId: string) =>
      run(conversationId, `/conversations/${conversationId}/retry`, undefined, null),
  };
}
