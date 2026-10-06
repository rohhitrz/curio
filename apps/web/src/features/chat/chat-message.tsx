'use client';

import type { CitationSnapshot, Feedback } from '@curio/shared';
import {
  AlertCircle,
  FileText,
  Globe,
  Loader2,
  RotateCcw,
  SquarePlay,
  StickyNote,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from 'cn';
import { AnswerMarkdown, type MarkdownVariant } from './answer-markdown';
import { citationDisplayNumbers, citationLocation, plainSnippet } from './citations';

export function QuestionBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <p className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap">
        {content}
      </p>
    </div>
  );
}

const sourceIcons = { PDF: FileText, WEBSITE: Globe, YOUTUBE: SquarePlay, TEXT: StickyNote };

function CitationList({
  citations,
  onCite,
  displayNumbers,
}: {
  citations: CitationSnapshot[];
  onCite: (citation: CitationSnapshot) => void;
  displayNumbers: Map<number, number>;
}) {
  const shown = (citation: CitationSnapshot) =>
    displayNumbers.get(citation.marker) ?? citation.marker;
  return (
    <ol
      className="mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5"
      aria-label="Sources for this answer"
    >
      {[...citations]
        .sort((a, b) => shown(a) - shown(b))
        .map((citation) => {
          const Icon = sourceIcons[citation.sourceType];
          const location = citationLocation(citation);
          return (
            <li key={citation.marker}>
              <button
                type="button"
                onClick={() => onCite(citation)}
                className="hover:bg-muted/60 flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors"
              >
                <span className="bg-primary/10 text-primary mt-0.5 inline-flex size-4.5 shrink-0 items-center justify-center rounded text-[0.7rem] font-semibold tabular-nums">
                  {shown(citation)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                    <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                    {/* Long titles and heading paths truncate: the card never widens the panel. */}
                    <span className="min-w-0 shrink truncate">{citation.sourceTitle}</span>
                    {location && (
                      <span className="text-muted-foreground min-w-0 flex-1 truncate font-normal">
                        · {location}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-xs break-words">
                    {plainSnippet(citation.snippet)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
    </ol>
  );
}

interface AnswerProps {
  text: string;
  citations: CitationSnapshot[];
  onCite: (citation: CitationSnapshot) => void;
  /** While streaming: the progress line before any text. */
  status?: string | null;
  streaming?: boolean;
  error?: string | null;
  /** Shown on a failed answer that is the conversation's last message. */
  onRetry?: (() => void) | undefined;
  feedback?: Feedback | null;
  /** Shown on saved, complete answers. */
  onFeedback?: ((value: Feedback | null) => void) | undefined;
  variant?: MarkdownVariant;
}

export function Answer({
  text,
  citations,
  onCite,
  status,
  streaming = false,
  error,
  onRetry,
  feedback = null,
  onFeedback,
  variant = 'chat',
}: AnswerProps) {
  const displayNumbers = useMemo(
    () =>
      citationDisplayNumbers(
        text,
        citations.map((c) => c.marker),
      ),
    [text, citations],
  );
  return (
    <div className="max-w-full min-w-0">
      {text === '' && streaming ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {status ?? 'Thinking…'}
        </p>
      ) : (
        text !== '' && (
          <AnswerMarkdown
            text={text}
            citations={citations}
            onCite={onCite}
            variant={variant}
            displayNumbers={displayNumbers}
          />
        )
      )}

      {error && (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive mt-2 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{error}</span>
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RotateCcw />
              Retry
            </Button>
          )}
        </div>
      )}

      {citations.length > 0 && (
        <div className={variant === 'lesson' ? 'mt-10 border-t pt-6' : undefined}>
          {variant === 'lesson' && (
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Sources cited in this lesson
            </h3>
          )}
          <CitationList citations={citations} onCite={onCite} displayNumbers={displayNumbers} />
        </div>
      )}

      {onFeedback && (
        <div className="mt-2 flex gap-1">
          {(
            [
              ['UP', ThumbsUp, 'Good answer'],
              ['DOWN', ThumbsDown, 'Bad answer'],
            ] as const
          ).map(([value, Icon, label]) => (
            <Button
              key={value}
              size="icon"
              variant="ghost"
              className={cn('size-7', feedback === value && 'bg-muted text-foreground')}
              aria-label={label}
              aria-pressed={feedback === value}
              onClick={() => onFeedback(feedback === value ? null : value)}
            >
              <Icon className="size-3.5" />
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
