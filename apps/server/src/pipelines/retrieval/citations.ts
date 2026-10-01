import { citationSnapshotsSchema, type CitationSnapshot } from '@curio/shared';
import type { ContextSource } from './context.js';

/** `[1]`, `[1, 2]`, `[1,2,3]`: one bracket can hold several markers. */
const MARKER_GROUP = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** The markers in `text`, in order of first appearance, each once. */
export function citedMarkers(text: string): number[] {
  const markers: number[] = [];
  for (const match of text.matchAll(MARKER_GROUP)) {
    for (const part of (match[1] ?? '').split(',')) {
      const marker = Number(part.trim());
      if (marker > 0 && !markers.includes(marker)) markers.push(marker);
    }
  }
  return markers;
}

/** Removes `[n]` markers, e.g. from earlier answers whose numbers meant other sources. */
export function stripMarkers(text: string): string {
  return text.replace(/ ?\[\d+(?:\s*,\s*\d+)*\]/g, '');
}

function snippet(content: string, maxChars: number): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * One snapshot per marker the answer cites, in order of first appearance. A snapshot copies what
 * the citation needs to open the exact spot, so it survives the source being reprocessed or
 * deleted. Markers that match no source get no snapshot (the citation check removes them).
 */
export function toCitationSnapshots(
  text: string,
  sources: ContextSource[],
  options: { snippetMaxChars: number },
): CitationSnapshot[] {
  const byMarker = new Map(sources.map((source) => [source.marker, source.chunk]));
  const snapshots = citedMarkers(text).flatMap((marker): CitationSnapshot[] => {
    const chunk = byMarker.get(marker);
    if (!chunk) return [];
    return [
      {
        marker,
        sourceId: chunk.sourceId,
        sourceTitle: chunk.sourceTitle,
        sourceType: chunk.sourceType,
        snippet: snippet(chunk.content, options.snippetMaxChars),
        pageNumber: chunk.location.pageNumber,
        startSeconds: chunk.location.startSeconds,
        headingPath: chunk.location.headingPath,
        charStart: chunk.location.charStart,
        charEnd: chunk.location.charEnd,
      },
    ];
  });
  // Same schema the message row is validated with (docs/03-database-design.md §1).
  return citationSnapshotsSchema.parse(snapshots);
}
