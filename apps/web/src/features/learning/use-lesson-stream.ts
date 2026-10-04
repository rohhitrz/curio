'use client';

import { lessonSchema } from '@curio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '@/app/providers';
import { applyChunk, emptyAnswer, readChatStream, type AnswerState } from '@/features/chat/stream';
import { isApiError } from '@/lib/api';
import { pathKeys } from './queries';

/** A little longer than the server's lesson lock (~2 min), which ends a crashed run. */
const WAIT_FOR_LESSON_MS = 150_000;
const POLL_MS = 3_000;

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

export interface LessonRun {
  moduleId: string;
  answer: AnswerState;
  /** Someone else is writing it, or the connection dropped: waiting for it to be saved. */
  waiting: boolean;
}

/**
 * Writes a module's lesson and follows it as it streams (docs/04-api-design.md §6, Lessons).
 * When the stream ends the saved lesson is reloaded. If the lesson is already being written
 * (409) or the connection drops, it waits for the saved one instead of starting another.
 */
export function useLessonStream(pathId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [run, setRun] = useState<LessonRun | null>(null);
  /** The last failure, per module, until another try. */
  const [failure, setFailure] = useState<{ moduleId: string; message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page stops reading; the server still finishes and saves the lesson.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function waitForSaved(moduleId: string, since: string | null, signal: AbortSignal) {
    const deadline = Date.now() + WAIT_FOR_LESSON_MS;
    while (!signal.aborted && Date.now() < deadline) {
      await sleep(POLL_MS, signal);
      try {
        const lesson = await api.get(`/modules/${moduleId}/lesson`, {
          schema: lessonSchema,
          signal,
        });
        if (lesson.id !== since) return;
      } catch {
        // Not saved yet, or still offline: keep waiting.
      }
    }
  }

  async function generate(moduleId: string, currentLessonId: string | null = null) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setFailure(null);
    setRun({ moduleId, answer: emptyAnswer, waiting: false });
    let answer = emptyAnswer;
    try {
      const stream = await api.stream(`/modules/${moduleId}/lessons`, undefined, {
        signal: controller.signal,
      });
      for await (const chunk of readChatStream(stream)) {
        answer = applyChunk(answer, chunk);
        const current = answer;
        setRun((r) => (r ? { ...r, answer: current } : r));
      }
      if (answer.error) setFailure({ moduleId, message: answer.error.message });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (isApiError(err) && err.code !== 'LESSON_GENERATING') {
        setFailure({ moduleId, message: err.message });
      } else {
        setRun({ moduleId, answer, waiting: true });
        await waitForSaved(moduleId, currentLessonId, controller.signal);
      }
    } finally {
      if (!controller.signal.aborted) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: pathKeys.lesson(moduleId) }),
          queryClient.invalidateQueries({ queryKey: pathKeys.outline(pathId) }),
        ]);
        setRun(null);
      }
    }
  }

  return {
    run,
    failure,
    generate: (moduleId: string, currentLessonId?: string | null) =>
      void generate(moduleId, currentLessonId ?? null),
    isRunning: (moduleId: string) => run?.moduleId === moduleId,
  };
}
