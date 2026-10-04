'use client';

import type { CitationSnapshot, OutlineModule } from '@curio/shared';
import { ArrowRight, CircleCheck, Clock, Loader2, RotateCcw, Undo2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Answer } from '@/features/chat/chat-message';
import { isApiError } from '@/lib/api';
import { DIFFICULTY_LABELS, formatMinutes } from './display';
import { useCompleteModule, useLesson } from './queries';
import type { useLessonStream } from './use-lesson-stream';

interface LessonPanelProps {
  pathId: string;
  module: OutlineModule;
  stream: ReturnType<typeof useLessonStream>;
  onCite: (citation: CitationSnapshot) => void;
  /** The next module to learn, if any. */
  onNext: (() => void) | null;
}

/**
 * One module's lesson (decision L-10): shown if saved, written and streamed right away if not.
 * Regenerate writes a new version; "Mark as done" saves progress and topic memory.
 */
export function LessonPanel({ pathId, module, stream, onCite, onNext }: LessonPanelProps) {
  const lesson = useLesson(module.id);
  const complete = useCompleteModule(pathId);
  const running = stream.run?.moduleId === module.id ? stream.run : null;
  const failure = stream.failure?.moduleId === module.id ? stream.failure.message : null;
  const notWritten =
    lesson.isError && isApiError(lesson.error) && lesson.error.code === 'LESSON_NOT_GENERATED';

  // Opening a module without a lesson writes it: once per module per visit.
  const started = useRef(new Set<string>());
  useEffect(() => {
    if (!notWritten || !module.isEnabled || started.current.has(module.id) || running) return;
    started.current.add(module.id);
    stream.generate(module.id);
  }, [notWritten, module.id, module.isEnabled, running, stream]);

  const done = module.completedAt !== null;

  return (
    // ~70 characters a line at the lesson's size: comfortable to read.
    <article aria-labelledby="lesson-title" className="mx-auto w-full max-w-[42rem] min-w-0">
      <header>
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Module {module.position}
        </p>
        <h2
          id="lesson-title"
          className="mt-1.5 text-2xl leading-tight sm:text-3xl font-semibold tracking-tight"
        >
          {module.title}
        </h2>
        <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-2 text-xs">
          {module.difficulty && (
            <Badge variant="outline">{DIFFICULTY_LABELS[module.difficulty]}</Badge>
          )}
          {module.minutes > 0 && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden />
              {formatMinutes(module.minutes)}
            </span>
          )}
          {done && (
            <span className="text-primary inline-flex items-center gap-1 font-medium">
              <CircleCheck className="size-3.5" aria-hidden />
              Done
            </span>
          )}
        </div>
        {module.why && (
          <p className="text-muted-foreground mt-4 text-[0.9375rem] leading-relaxed">
            {module.why}
          </p>
        )}
      </header>

      <div className="mt-8 border-t pt-8" aria-live="polite">
        {!module.isEnabled ? (
          <p className="text-muted-foreground rounded-lg border p-4 text-sm">
            This module is turned off. Turn it on in the path to learn it.
          </p>
        ) : running ? (
          running.waiting && running.answer.text === '' ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Your lesson is being written…
            </p>
          ) : (
            <Answer
              text={running.answer.text}
              citations={running.answer.citations}
              onCite={onCite}
              status={running.answer.status}
              streaming
              error={running.answer.error?.message ?? null}
              variant="lesson"
            />
          )
        ) : failure ? (
          <div role="alert" className="rounded-lg border p-4 text-sm">
            <p className="text-destructive">{failure}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => stream.generate(module.id, lesson.data?.id)}
            >
              <RotateCcw />
              Try again
            </Button>
          </div>
        ) : lesson.isSuccess ? (
          <Answer
            text={lesson.data.content}
            citations={lesson.data.citations}
            onCite={onCite}
            variant="lesson"
          />
        ) : lesson.isError && !notWritten ? (
          <div className="rounded-lg border p-4 text-center text-sm">
            <p>Couldn’t load this lesson.</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => void lesson.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <div className="space-y-3" aria-label="Loading">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        )}
      </div>

      {module.isEnabled && lesson.isSuccess && !running && (
        <footer className="mt-10 flex flex-wrap items-center gap-2 border-t pt-6">
          {done ? (
            <Button
              variant="outline"
              disabled={complete.isPending}
              onClick={() => complete.mutate({ moduleId: module.id, completed: false })}
            >
              <Undo2 />
              Mark as not done
            </Button>
          ) : (
            <Button
              disabled={complete.isPending}
              onClick={() => complete.mutate({ moduleId: module.id, completed: true })}
            >
              {complete.isPending ? <Loader2 className="animate-spin" /> : <CircleCheck />}
              Mark as done
            </Button>
          )}
          {done && onNext && (
            <Button onClick={onNext}>
              Next module
              <ArrowRight />
            </Button>
          )}
          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() => stream.generate(module.id, lesson.data.id)}
          >
            <RotateCcw />
            Regenerate
          </Button>
          {complete.isError && (
            <p className="text-destructive w-full text-sm" role="alert">
              {isApiError(complete.error)
                ? complete.error.message
                : 'Couldn’t save your progress. Please try again.'}
            </p>
          )}
          <p className="text-muted-foreground w-full text-xs">
            Version {lesson.data.version}. Marking a module done tells Curio you understand its
            concepts; it shapes later explanations.
          </p>
        </footer>
      )}
    </article>
  );
}
