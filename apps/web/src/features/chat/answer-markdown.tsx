'use client';

import type { CitationSnapshot } from '@curio/shared';
import { useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import { citationDisplayNumbers, citationMarkerFromHref, linkCitationMarkers } from './citations';
import { normalizeMath } from './math';

export type MarkdownVariant = 'chat' | 'lesson';

interface AnswerMarkdownProps {
  text: string;
  citations: CitationSnapshot[];
  onCite: (citation: CitationSnapshot) => void;
  /** `lesson`: long-form reading (serif, larger, roomier); `chat`: compact answers. */
  variant?: MarkdownVariant;
  /** The number each marker is shown with (`citationDisplayNumbers`); computed here if absent. */
  displayNumbers?: Map<number, number>;
}

/** Plain styles for the Markdown elements answers use (no typography plugin in the app). */
const chatComponents: Components = {
  p: ({ children }) => <p className="my-2.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1.5 pl-5">{children}</ol>,
  h1: ({ children }) => <h3 className="mt-4 mb-1.5 font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-1.5 font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-4 mb-1.5 font-semibold">{children}</h4>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="text-muted-foreground my-2.5 border-l-2 pl-3">{children}</blockquote>
  ),
  pre: ({ children }) => (
    <pre className="bg-muted my-3 max-w-full overflow-x-auto rounded-md p-3 text-[0.8125rem] leading-relaxed [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.875em]">{children}</code>
  ),
  table: ({ children }) => (
    <div className="my-3 max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-left text-[0.8125rem]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border px-2 py-1 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
};

/**
 * A lesson is read top to bottom like a chapter: a text serif at a larger size, generous line
 * height and paragraph spacing, sans-serif section headings, and a note box for the
 * "General knowledge" line (decision L-10).
 */
const lessonComponents: Components = {
  p: ({ children }) => <p className="my-5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="marker:text-muted-foreground my-5 list-disc space-y-2.5 pl-6">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="marker:text-muted-foreground my-5 list-decimal space-y-2.5 pl-6">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  h1: ({ children }) => (
    <h3 className="mt-12 mb-4 font-sans text-2xl font-semibold tracking-tight">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-12 mb-4 border-t pt-8 font-sans text-[1.375rem] leading-snug font-semibold tracking-tight first:mt-0 first:border-t-0 first:pt-0">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-8 mb-3 font-sans text-lg font-semibold tracking-tight">{children}</h4>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="bg-muted/60 text-muted-foreground my-6 rounded-lg border-l-4 px-5 py-3 font-sans text-[0.9375rem] leading-relaxed [&_p]:my-1">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="bg-muted my-6 max-w-full overflow-x-auto rounded-lg border p-4 font-mono text-[0.875rem] leading-relaxed [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[1em]">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  table: ({ children }) => (
    <div className="my-6 max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-left font-sans text-[0.9375rem]">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => <th className="bg-muted/60 border px-3 py-2 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border px-3 py-2 align-top">{children}</td>,
};

const wrapperClass: Record<MarkdownVariant, string> = {
  chat: 'min-w-0 text-[0.9375rem] leading-relaxed break-words',
  lesson:
    'min-w-0 font-serif text-[1.0625rem] leading-[1.8] sm:text-[1.125rem] break-words text-foreground/90',
};

/** An answer's Markdown, with `[n]` markers as clickable citation chips. */
export function AnswerMarkdown({
  text,
  citations,
  onCite,
  variant = 'chat',
  displayNumbers,
}: AnswerMarkdownProps) {
  const byMarker = useMemo(() => new Map(citations.map((c) => [c.marker, c])), [citations]);
  const numbers = useMemo(
    () => displayNumbers ?? citationDisplayNumbers(text, [...byMarker.keys()]),
    [displayNumbers, text, byMarker],
  );
  const linked = useMemo(
    () => linkCitationMarkers(normalizeMath(text), new Set(byMarker.keys())),
    [text, byMarker],
  );

  const components: Components = {
    ...(variant === 'lesson' ? lessonComponents : chatComponents),
    a: ({ href, children }) => {
      const marker = citationMarkerFromHref(href);
      const citation = marker === null ? undefined : byMarker.get(marker);
      if (citation) {
        const shown = numbers.get(citation.marker) ?? citation.marker;
        return (
          <button
            type="button"
            onClick={() => onCite(citation)}
            title={citation.sourceTitle}
            aria-label={`Source ${String(shown)}: ${citation.sourceTitle}`}
            className="bg-primary/10 text-primary hover:bg-primary/20 mx-0.5 inline-flex h-4.5 min-w-4.5 translate-y-[-1px] items-center justify-center rounded px-1 align-middle font-sans text-[0.7rem] leading-none font-semibold tabular-nums transition-colors"
          >
            {shown}
          </button>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          {children}
        </a>
      );
    },
  };

  return (
    <div className={wrapperClass[variant]}>
      <Markdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {linked}
      </Markdown>
    </div>
  );
}
