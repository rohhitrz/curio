import { describe, expect, it } from 'vitest';
import type { ExtractedContent } from './extract.js';
import { fromStored, toStored } from './stored-content.js';

const pagesWithAnEmptyOne: ExtractedContent = {
  kind: 'pages',
  pages: [
    { pageNumber: 1, text: 'First page.' },
    { pageNumber: 2, text: '' },
    { pageNumber: 3, text: 'Third\n\npage.' },
  ],
};

const cases: [string, ExtractedContent][] = [
  ['markdown', { kind: 'markdown', markdown: '# Title\n\nBody text.' }],
  ['pages, including an empty one', pagesWithAnEmptyOne],
  [
    'a transcript',
    {
      kind: 'transcript',
      segments: [
        { text: 'Hello there.', startSeconds: 0, endSeconds: 2.5 },
        { text: 'Welcome back.', startSeconds: 2.5, endSeconds: 6.04 },
      ],
    },
  ],
  ['empty pages', { kind: 'pages', pages: [] }],
  ['an empty transcript', { kind: 'transcript', segments: [] }],
];

describe('stored content', () => {
  it.each(cases)('%s survives a round trip through text + locations', (_label, content) => {
    const { text, locations } = toStored(content);

    // Locations go through JSON on their way to and from the database.
    expect(fromStored(text, JSON.parse(JSON.stringify(locations)))).toEqual(content);
  });

  it('stores lengths, not the text again', () => {
    const { text, locations } = toStored(pagesWithAnEmptyOne);

    expect(text).toBe('First page.\n\n\n\nThird\n\npage.');
    expect(locations).toEqual({
      kind: 'pages',
      pages: [
        { pageNumber: 1, length: 11 },
        { pageNumber: 2, length: 0 },
        { pageNumber: 3, length: 12 },
      ],
    });
  });

  it('rejects locations that do not fit the text, or are not locations at all', () => {
    const { locations } = toStored(pagesWithAnEmptyOne);

    expect(() => fromStored('a different text', locations)).toThrow(
      'stored locations do not match the extracted text',
    );
    expect(() => fromStored('text', null)).toThrow();
    expect(() => fromStored('text', { kind: 'slides' })).toThrow();
  });
});
