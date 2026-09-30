import { z } from 'zod';
import { fullText, PAGE_SEPARATOR, SEGMENT_SEPARATOR } from './chunk.js';
import type { ExtractedContent } from './extract.js';

/**
 * What is kept in `sources.extracted_locations`, next to the full text in `extracted_text`.
 * Together they rebuild the extracted content, so job steps only pass the source ID. Only lengths
 * are stored, not the text again.
 */
const storedLocationsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('markdown') }),
  z.object({
    kind: z.literal('pages'),
    pages: z.array(
      z.object({ pageNumber: z.number().int(), length: z.number().int().nonnegative() }),
    ),
  }),
  z.object({
    kind: z.literal('transcript'),
    /** `[startSeconds, endSeconds, length]` per caption segment. */
    segments: z.array(z.tuple([z.number(), z.number(), z.number().int().nonnegative()])),
  }),
]);

export type StoredLocations = z.infer<typeof storedLocationsSchema>;

export function toStored(content: ExtractedContent): { text: string; locations: StoredLocations } {
  const text = fullText(content);
  switch (content.kind) {
    case 'markdown':
      return { text, locations: { kind: 'markdown' } };
    case 'pages':
      return {
        text,
        locations: {
          kind: 'pages',
          pages: content.pages.map((page) => ({
            pageNumber: page.pageNumber,
            length: page.text.length,
          })),
        },
      };
    case 'transcript':
      return {
        text,
        locations: {
          kind: 'transcript',
          segments: content.segments.map((segment) => [
            segment.startSeconds,
            segment.endSeconds,
            segment.text.length,
          ]),
        },
      };
  }
}

/** Rebuilds the extracted content. Throws if the stored locations don't fit the text. */
export function fromStored(text: string, locations: unknown): ExtractedContent {
  const stored = storedLocationsSchema.parse(locations);

  /** Cuts `text` into consecutive pieces of the given lengths, skipping the separator between. */
  const cut = (lengths: number[], separator: string): string[] => {
    const pieces: string[] = [];
    let offset = 0;
    for (const length of lengths) {
      pieces.push(text.slice(offset, offset + length));
      offset += length + separator.length;
    }
    const expectedLength = Math.max(0, offset - separator.length);
    if (expectedLength !== text.length) {
      throw new Error('stored locations do not match the extracted text');
    }
    return pieces;
  };

  switch (stored.kind) {
    case 'markdown':
      return { kind: 'markdown', markdown: text };
    case 'pages': {
      const texts = cut(
        stored.pages.map((page) => page.length),
        PAGE_SEPARATOR,
      );
      return {
        kind: 'pages',
        pages: stored.pages.map((page, index) => ({
          pageNumber: page.pageNumber,
          text: texts[index] ?? '',
        })),
      };
    }
    case 'transcript': {
      const texts = cut(
        stored.segments.map(([, , length]) => length),
        SEGMENT_SEPARATOR,
      );
      return {
        kind: 'transcript',
        segments: stored.segments.map(([startSeconds, endSeconds], index) => ({
          text: texts[index] ?? '',
          startSeconds,
          endSeconds,
        })),
      };
    }
  }
}
