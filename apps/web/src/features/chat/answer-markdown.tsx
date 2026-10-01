'use client';

import type { CitationSnapshot } from '@curio/shared';
import { useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { citationMarkerFromHref, linkCitationMarkers } from './citations';

interface AnswerMarkdownProps {
  text: string;
  citations: CitationSnapshot[];
  onCite: (citation: CitationSnapshot) => void;
}

/** Plain styles for the Markdown elements answers use (no typography plugin in the app). */
const baseComponents: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  h1: ({ children }) => <h3 className="mt-3 mb-1 font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1 font-semibold">{children}</h4>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="text-muted-foreground my-2 border-l-2 pl-3">{children}</blockquote>
  ),
  pre: ({ children }) => (
    <pre className="bg-muted my-2 overflow-x-auto rounded-md p-3 text-xs">{children}</pre>
  ),
  code: ({ children }) => (
    <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border px-2 py-1 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
};

/** An answer's Markdown, with `[n]` markers as clickable citation chips. */
export function AnswerMarkdown({ text, citations, onCite }: AnswerMarkdownProps) {
  const byMarker = useMemo(() => new Map(citations.map((c) => [c.marker, c])), [citations]);
  const linked = useMemo(
    () => linkCitationMarkers(text, new Set(byMarker.keys())),
    [text, byMarker],
  );

  const components: Components = {
    ...baseComponents,
    a: ({ href, children }) => {
      const marker = citationMarkerFromHref(href);
      const citation = marker === null ? undefined : byMarker.get(marker);
      if (citation) {
        return (
          <button
            type="button"
            onClick={() => onCite(citation)}
            title={citation.sourceTitle}
            aria-label={`Source ${citation.marker}: ${citation.sourceTitle}`}
            className="bg-primary/10 text-primary hover:bg-primary/20 mx-0.5 inline-flex h-4.5 min-w-4.5 translate-y-[-1px] items-center justify-center rounded px-1 align-middle text-[0.7rem] font-semibold tabular-nums transition-colors"
          >
            {citation.marker}
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
    <div className="text-sm leading-relaxed break-words">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {linked}
      </Markdown>
    </div>
  );
}
