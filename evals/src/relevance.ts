import type { ExpectedLocation } from './questions.js';

/** The parts of a retrieved or stored chunk that relevance looks at. */
export interface LocatedChunk {
  documentId: string;
  pageNumber: number | null;
  startSeconds: number | null;
  endSeconds: number | null;
  headingPath: string | null;
}

/**
 * Whether a chunk is at an expected location (test plan §6.2): same document and same page ·
 * a time range overlapping the expected window · the same heading path.
 */
export function matchesLocation(chunk: LocatedChunk, location: ExpectedLocation): boolean {
  if (chunk.documentId !== location.documentId) return false;
  if ('pageNumber' in location) return chunk.pageNumber === location.pageNumber;
  if ('startSeconds' in location) {
    return (
      chunk.startSeconds !== null &&
      chunk.endSeconds !== null &&
      chunk.startSeconds < location.endSeconds &&
      chunk.endSeconds > location.startSeconds
    );
  }
  return chunk.headingPath === location.headingPath;
}

export function isRelevant(chunk: LocatedChunk, locations: ExpectedLocation[]): boolean {
  return locations.some((location) => matchesLocation(chunk, location));
}
