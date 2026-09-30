import type { Source, SourceChunk } from '@curio/shared';

/** Text and chunks exist once a source has been processed. */
export function canViewSource(source: Pick<Source, 'status'>): boolean {
  return source.status === 'READY';
}

/** The API only reprocesses finished sources; anything else is already on its way. */
export function canReprocessSource(source: Pick<Source, 'status'>): boolean {
  return source.status === 'READY' || source.status === 'FAILED';
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

type ChunkLocation = Pick<
  SourceChunk,
  'pageNumber' | 'startSeconds' | 'endSeconds' | 'headingPath'
>;

/** Where a chunk sits in its source: "Page 3", "1:15 – 2:40", a heading path, or null. */
export function chunkLocation(chunk: ChunkLocation): string | null {
  if (chunk.pageNumber !== null) return `Page ${chunk.pageNumber}`;
  if (chunk.startSeconds !== null) {
    const start = formatTimestamp(chunk.startSeconds);
    return chunk.endSeconds === null ? start : `${start} – ${formatTimestamp(chunk.endSeconds)}`;
  }
  return chunk.headingPath;
}

export interface HighlightRange {
  start: number;
  end: number;
}

/**
 * Splits text around a passage to highlight. Null when the range doesn't fit the text (e.g. the
 * source was reprocessed after the chunks were loaded), so the viewer just shows the text.
 */
export function splitForHighlight(
  text: string,
  range: HighlightRange | null,
): { before: string; match: string; after: string } | null {
  if (!range) return null;
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start || end > text.length) return null;
  return { before: text.slice(0, start), match: text.slice(start, end), after: text.slice(end) };
}
