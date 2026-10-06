import type { CitationSnapshot, Source } from '@curio/shared';
import { formatTimestamp } from '@/features/sources/viewer';

/** Where a citation points: "Page 4", "1:15", a heading path, or null. */
export function citationLocation(citation: CitationSnapshot): string | null {
  if (citation.pageNumber !== null) return `Page ${citation.pageNumber}`;
  if (citation.startSeconds !== null) return formatTimestamp(citation.startSeconds);
  return citation.headingPath;
}

/** What clicking a citation opens (PRD §5.5: the exact spot). */
export type CitationTarget =
  /** PDF in the browser's viewer, at the page (a fresh signed URL is fetched first). */
  | { kind: 'pdf'; sourceId: string; page: number | null }
  /** A link that already holds the spot, e.g. a YouTube video at the timestamp. */
  | { kind: 'url'; url: string }
  /** The source's text in the viewer, the passage highlighted. */
  | { kind: 'passage'; sourceId: string; range: { start: number; end: number } | null }
  /** The source was deleted or can't be opened now: only the snippet remains. */
  | { kind: 'unavailable' };

type CitedSource = Pick<Source, 'id' | 'type' | 'url' | 'status'>;

/** A YouTube URL that starts playing at `seconds`. Other URLs are returned unchanged. */
export function youtubeAt(url: string, seconds: number): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(parsed.hostname)) return url;
  parsed.searchParams.set('t', `${Math.max(0, Math.floor(seconds))}s`);
  return parsed.toString();
}

/** The signed PDF URL, opened at `page` by the browser's PDF viewer. */
export function pdfAtPage(url: string, page: number | null): string {
  const base = url.split('#')[0] ?? url;
  return page === null ? base : `${base}#page=${page}`;
}

/** `source` is the notebook's current source with that ID, if it still exists. */
export function citationTarget(
  citation: CitationSnapshot,
  source: CitedSource | undefined,
): CitationTarget {
  if (!source || source.status !== 'READY') return { kind: 'unavailable' };
  switch (citation.sourceType) {
    case 'PDF':
      return { kind: 'pdf', sourceId: source.id, page: citation.pageNumber };
    case 'YOUTUBE':
      if (!source.url) return { kind: 'unavailable' };
      return {
        kind: 'url',
        url:
          citation.startSeconds === null
            ? source.url
            : youtubeAt(source.url, citation.startSeconds),
      };
    case 'WEBSITE':
    case 'TEXT':
      return {
        kind: 'passage',
        sourceId: source.id,
        range:
          citation.charStart !== null && citation.charEnd !== null
            ? { start: citation.charStart, end: citation.charEnd }
            : null,
      };
  }
}

const CITE_PREFIX = '#cite-';
const MARKER_GROUP = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
/** Fenced code blocks and inline code: markers inside them are left alone. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

/**
 * Turns `[n]` markers into Markdown links (`[n](#cite-n)`) that the renderer shows as citation
 * chips. Markers with no citation (the model invented a number) are removed.
 */
export function linkCitationMarkers(text: string, markers: ReadonlySet<number>): string {
  return text
    .split(CODE)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(MARKER_GROUP, (_match, group: string) =>
            group
              .split(',')
              .map((n) => Number(n.trim()))
              .filter((n) => markers.has(n))
              .map((n) => `[${n}](${CITE_PREFIX}${n})`)
              .join(''),
          ),
    )
    .join('');
}

/** The marker of a citation link made by `linkCitationMarkers`, or null for other links. */
export function citationMarkerFromHref(href: string | undefined): number | null {
  if (!href?.startsWith(CITE_PREFIX)) return null;
  const marker = Number(href.slice(CITE_PREFIX.length));
  return Number.isInteger(marker) && marker > 0 ? marker : null;
}

/**
 * The number each citation is shown with: 1, 2, 3… in the order the answer first cites them, so
 * an answer never reads "[5] [6] … [1]" (the stored markers follow the context, not the text).
 * Citations the text never mentions come last, in marker order. Markers in code are ignored.
 */
export function citationDisplayNumbers(
  text: string,
  markers: readonly number[],
): Map<number, number> {
  const known = new Set(markers);
  const order: number[] = [];
  text.split(CODE).forEach((part, index) => {
    if (index % 2 === 1) return;
    for (const match of part.matchAll(MARKER_GROUP)) {
      for (const n of (match[1] ?? '').split(',').map((s) => Number(s.trim()))) {
        if (known.has(n) && !order.includes(n)) order.push(n);
      }
    }
  });
  for (const marker of [...markers].sort((a, b) => a - b)) {
    if (!order.includes(marker)) order.push(marker);
  }
  return new Map(order.map((marker, index) => [marker, index + 1]));
}

/**
 * A chunk's text as a snippet reads: Markdown links become their text (also one cut off at the
 * end), emphasis and code marks and escaping backslashes go, whitespace collapses (scraped pages
 * arrive as Markdown).
 */
export function plainSnippet(snippet: string): string {
  return (
    snippet
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // A snippet cut off inside a link: "[Ordinary Least…" or "[OLS](https://…"
      .replace(/!?\[([^\]]*)\]\([^)]*$/, '$1')
      .replace(/!?\[([^\]]*)$/, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/`+([^`]*)`+/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
