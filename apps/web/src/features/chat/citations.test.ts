import type { CitationSnapshot } from '@curio/shared';
import { describe, expect, it } from 'vitest';
import {
  citationLocation,
  citationMarkerFromHref,
  citationTarget,
  linkCitationMarkers,
  pdfAtPage,
  youtubeAt,
} from './citations';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';

function citation(overrides: Partial<CitationSnapshot> = {}): CitationSnapshot {
  return {
    marker: 1,
    sourceId: SOURCE_ID,
    sourceTitle: 'Notes',
    sourceType: 'PDF',
    snippet: 'Dropout drops units.',
    pageNumber: null,
    startSeconds: null,
    headingPath: null,
    charStart: null,
    charEnd: null,
    ...overrides,
  };
}

const ready = (type: CitationSnapshot['sourceType'], url: string | null = null) =>
  ({ id: SOURCE_ID, type, url, status: 'READY' }) as const;

describe('citationTarget', () => {
  it('PDF → the page', () => {
    expect(citationTarget(citation({ pageNumber: 12 }), ready('PDF'))).toEqual({
      kind: 'pdf',
      sourceId: SOURCE_ID,
      page: 12,
    });
  });

  it('YouTube → the video at the timestamp', () => {
    const target = citationTarget(
      citation({ sourceType: 'YOUTUBE', startSeconds: 125.7 }),
      ready('YOUTUBE', 'https://www.youtube.com/watch?v=abc'),
    );

    expect(target).toEqual({ kind: 'url', url: 'https://www.youtube.com/watch?v=abc&t=125s' });
  });

  it('website and text → the passage, highlighted', () => {
    expect(
      citationTarget(
        citation({ sourceType: 'WEBSITE', charStart: 10, charEnd: 40 }),
        ready('WEBSITE', 'https://example.com'),
      ),
    ).toEqual({ kind: 'passage', sourceId: SOURCE_ID, range: { start: 10, end: 40 } });
    expect(citationTarget(citation({ sourceType: 'TEXT' }), ready('TEXT'))).toEqual({
      kind: 'passage',
      sourceId: SOURCE_ID,
      range: null,
    });
  });

  it('a deleted or unfinished source leaves only the snippet', () => {
    expect(citationTarget(citation({ pageNumber: 3 }), undefined)).toEqual({ kind: 'unavailable' });
    expect(
      citationTarget(citation({ pageNumber: 3 }), { ...ready('PDF'), status: 'PROCESSING' }),
    ).toEqual({ kind: 'unavailable' });
  });
});

describe('links', () => {
  it('youtubeAt sets t on YouTube links (both hosts) and leaves others alone', () => {
    expect(youtubeAt('https://youtu.be/abc', 65)).toBe('https://youtu.be/abc?t=65s');
    expect(youtubeAt('https://www.youtube.com/watch?v=abc&t=10s', 65)).toBe(
      'https://www.youtube.com/watch?v=abc&t=65s',
    );
    expect(youtubeAt('https://example.com/video', 65)).toBe('https://example.com/video');
    expect(youtubeAt('not a url', 65)).toBe('not a url');
  });

  it('pdfAtPage adds the page fragment', () => {
    expect(pdfAtPage('https://r2.test/a.pdf?sig=1', 7)).toBe('https://r2.test/a.pdf?sig=1#page=7');
    expect(pdfAtPage('https://r2.test/a.pdf#x', null)).toBe('https://r2.test/a.pdf');
  });

  it('labels the location', () => {
    expect(citationLocation(citation({ pageNumber: 4 }))).toBe('Page 4');
    expect(citationLocation(citation({ startSeconds: 75 }))).toBe('1:15');
    expect(citationLocation(citation({ headingPath: 'Intro › Setup' }))).toBe('Intro › Setup');
    expect(citationLocation(citation())).toBeNull();
  });
});

describe('linkCitationMarkers', () => {
  it('links known markers, splits groups, and drops unknown ones', () => {
    expect(linkCitationMarkers('A [1]. B [1, 2]. C [9].', new Set([1, 2]))).toBe(
      'A [1](#cite-1). B [1](#cite-1)[2](#cite-2). C .',
    );
  });

  it('leaves code alone', () => {
    const text = 'Use `arr[1]` here [1].\n\n```\nx = y[2]\n```';
    expect(linkCitationMarkers(text, new Set([1, 2]))).toBe(
      'Use `arr[1]` here [1](#cite-1).\n\n```\nx = y[2]\n```',
    );
  });

  it('reads the marker back from the link', () => {
    expect(citationMarkerFromHref('#cite-3')).toBe(3);
    expect(citationMarkerFromHref('https://example.com')).toBeNull();
    expect(citationMarkerFromHref(undefined)).toBeNull();
  });
});
