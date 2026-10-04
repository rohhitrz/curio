'use client';

import { MESSAGE_CONTENT_MAX, type CitationSnapshot, type Lesson } from '@curio/shared';
import { CircleCheck, GraduationCap, SendHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Answer, QuestionBubble } from '@/features/chat/chat-message';
import { buildChatItems } from '@/features/chat/display';
import { useCreateConversation, useMessages } from '@/features/chat/queries';
import { useAnswerStream } from '@/features/chat/use-answer-stream';
import { useCompleteModule } from './queries';

interface TutorPanelProps {
  pathId: string;
  notebookId: string;
  moduleId: string;
  moduleTitle: string;
  done: boolean;
  /** The lesson on screen; the tutor waits for it. */
  lesson: Lesson | null;
  onCite: (citation: CitationSnapshot) => void;
}

/**
 * The module's tutor (decision L-10): a chat tied to the lesson, searching only what the lesson
 * cites and staying on the module. When the learner seems ready it offers "Mark as done"; it
 * never marks it itself.
 */
export function TutorPanel({
  pathId,
  notebookId,
  moduleId,
  moduleTitle,
  done,
  lesson,
  onCite,
}: TutorPanelProps) {
  const createConversation = useCreateConversation(notebookId);
  const answer = useAnswerStream(notebookId);
  const complete = useCompleteModule(pathId);
  /** Tutor chats started on this visit, per module (before the lesson is reloaded). */
  const [started, setStarted] = useState<Record<string, string>>({});
  const [suggested, setSuggested] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const conversationId = started[moduleId] ?? lesson?.conversationId ?? null;
  const messages = useMessages(conversationId);
  const items = buildChatItems(messages.data ?? [], answer.pending, conversationId);

  // The tutor's "ready to move on" signal outlives the stream: keep it for this module.
  const signal = answer.pending?.answer.suggestComplete?.moduleId ?? null;
  useEffect(() => {
    if (signal) setSuggested((s) => ({ ...s, [signal]: true }));
  }, [signal]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const lastItem = items.at(-1);
  const scrollKey = `${conversationId}:${items.length}:${lastItem?.kind === 'answer' ? lastItem.text.length : 0}`;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [scrollKey]);

  async function send() {
    const content = draft.trim();
    if (content === '' || answer.isStreaming || !lesson) return;
    setNotice(null);
    answer.clearError();
    let id = conversationId;
    if (!id) {
      try {
        const created = await createConversation.mutateAsync(lesson.id);
        id = created.id;
        setStarted((s) => ({ ...s, [moduleId]: created.id }));
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Couldn’t reach your tutor.');
        return;
      }
    }
    setDraft('');
    await answer.send(id, content);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const busy = answer.isStreaming || createConversation.isPending;

  return (
    <section
      aria-labelledby="tutor-heading"
      className="bg-card flex h-full min-h-0 flex-col rounded-xl border"
    >
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <GraduationCap className="text-muted-foreground size-4" aria-hidden />
        <h2 id="tutor-heading" className="truncate text-sm font-medium">
          Your tutor · {moduleTitle}
        </h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        {conversationId && messages.isPending ? (
          <div className="space-y-3" aria-label="Loading">
            <Skeleton className="ml-auto h-9 w-2/3 rounded-2xl" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="font-medium">Stuck on something?</p>
            <p className="text-muted-foreground mt-1 max-w-xs text-sm">
              {lesson
                ? 'Ask about this lesson. Your tutor knows what you’re reading and answers from the same sources.'
                : 'Your tutor is ready once the lesson is written.'}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {items.map((item) =>
              item.kind === 'question' ? (
                <QuestionBubble key={item.key} content={item.content} />
              ) : (
                <Answer
                  key={item.key}
                  text={item.text}
                  citations={item.citations}
                  onCite={onCite}
                  status={item.status}
                  streaming={item.streaming}
                  error={item.error}
                />
              ),
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <form
        className="border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {suggested[moduleId] && !done && (
          <div
            role="status"
            className="bg-muted mb-2 flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm"
          >
            <CircleCheck className="text-primary size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">Sounds like you’ve got this module.</span>
            <Button
              type="button"
              size="sm"
              disabled={complete.isPending}
              onClick={() => complete.mutate({ moduleId, completed: true })}
            >
              Mark as done
            </Button>
          </div>
        )}
        {(answer.error ?? notice) && (
          <p role="alert" className="text-destructive mb-2 text-sm">
            {answer.error?.message ?? notice}
          </p>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={lesson ? 'Ask your tutor…' : 'Waiting for the lesson…'}
            aria-label="Your question for the tutor"
            maxLength={MESSAGE_CONTENT_MAX}
            rows={1}
            disabled={!lesson}
            className="max-h-40 min-h-10 resize-none"
          />
          <Button
            type="submit"
            size="icon"
            disabled={busy || !lesson || draft.trim() === ''}
            aria-label="Send"
          >
            <SendHorizontal />
          </Button>
        </div>
      </form>
    </section>
  );
}
