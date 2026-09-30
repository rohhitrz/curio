import { describe, expect, it } from 'vitest';
import { questionSchema } from './questions.js';
import { isRelevant, matchesLocation, type LocatedChunk } from './relevance.js';

function chunk(overrides: Partial<LocatedChunk> = {}): LocatedChunk {
  return {
    documentId: 'doc-a',
    pageNumber: null,
    startSeconds: null,
    endSeconds: null,
    headingPath: null,
    ...overrides,
  };
}

describe('matchesLocation', () => {
  it('PDF: same document and same page', () => {
    const location = { documentId: 'doc-a', pageNumber: 7 };
    expect(matchesLocation(chunk({ pageNumber: 7 }), location)).toBe(true);
    expect(matchesLocation(chunk({ pageNumber: 8 }), location)).toBe(false);
    expect(matchesLocation(chunk({ documentId: 'doc-b', pageNumber: 7 }), location)).toBe(false);
  });

  it('YouTube: a chunk whose time range overlaps the window', () => {
    const location = { documentId: 'doc-a', startSeconds: 100, endSeconds: 120 };
    const at = (startSeconds: number, endSeconds: number) =>
      matchesLocation(chunk({ startSeconds, endSeconds }), location);

    expect(at(90, 110)).toBe(true); // overlaps the start
    expect(at(110, 200)).toBe(true); // overlaps the end
    expect(at(50, 300)).toBe(true); // contains the window
    expect(at(105, 115)).toBe(true); // inside the window
    expect(at(0, 100)).toBe(false); // ends exactly where the window starts
    expect(at(120, 150)).toBe(false); // starts exactly where it ends
    expect(matchesLocation(chunk(), location)).toBe(false); // no timestamps
  });

  it('website / text: exactly the same heading path, and null only matches null', () => {
    const location = { documentId: 'doc-a', headingPath: 'Guide › Setup' };
    expect(matchesLocation(chunk({ headingPath: 'Guide › Setup' }), location)).toBe(true);
    expect(matchesLocation(chunk({ headingPath: 'Guide' }), location)).toBe(false);
    expect(matchesLocation(chunk({ headingPath: 'Guide › Setup › Details' }), location)).toBe(
      false,
    );

    const lead = { documentId: 'doc-a', headingPath: null };
    expect(matchesLocation(chunk({ headingPath: null }), lead)).toBe(true);
    expect(matchesLocation(chunk({ headingPath: 'Guide' }), lead)).toBe(false);
  });

  it('isRelevant: any expected location is enough', () => {
    const locations = [
      { documentId: 'doc-a', pageNumber: 1 },
      { documentId: 'doc-b', pageNumber: 2 },
    ];
    expect(isRelevant(chunk({ documentId: 'doc-b', pageNumber: 2 }), locations)).toBe(true);
    expect(isRelevant(chunk({ documentId: 'doc-b', pageNumber: 1 }), locations)).toBe(false);
    expect(isRelevant(chunk(), [])).toBe(false);
  });
});

describe('questionSchema', () => {
  const base = {
    id: 'q-001',
    category: 'factual',
    answerable: true,
    history: [],
    question: 'What is d_model?',
    expectedAnswer: '512',
    expectedLocations: [{ documentId: 'doc-a', pageNumber: 3 }],
  };

  it('accepts a well-formed question', () => {
    expect(questionSchema.safeParse(base).success).toBe(true);
  });

  it.each([
    ['an answerable question without locations', { expectedLocations: [] }],
    ['an unanswerable question marked answerable', { category: 'unanswerable' }],
    ['an unanswerable question with locations', { category: 'unanswerable', answerable: false }],
    ['a follow-up without history', { category: 'follow-up' }],
    ['history on a non-follow-up', { history: [{ role: 'user', content: 'Hi' }] }],
    [
      'a time window that ends before it starts',
      {
        expectedLocations: [{ documentId: 'doc-a', startSeconds: 20, endSeconds: 10 }],
      },
    ],
    [
      'a location with a mix of shapes',
      {
        expectedLocations: [{ documentId: 'doc-a', pageNumber: 3, headingPath: 'X' }],
      },
    ],
    ['a malformed id', { id: 'q-1' }],
  ])('rejects %s', (_, overrides) => {
    expect(questionSchema.safeParse({ ...base, ...overrides }).success).toBe(false);
  });
});
