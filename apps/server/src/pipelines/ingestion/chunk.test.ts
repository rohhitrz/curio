import { describe, expect, it } from 'vitest';
import { chunking } from '../../config/index.js';
import { chunkContent, fullText, type Chunk, type ChunkOptions } from './chunk.js';
import type { ExtractedContent } from './extract.js';
import { countTokens } from './tokens.js';

/** One token per word: makes sizes in tests easy to reason about. */
const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

function options(overrides: Partial<ChunkOptions> = {}): ChunkOptions {
  return {
    title: 'Guide',
    targetTokens: 50,
    overlapRatio: 0,
    countTokens: countWords,
    ...overrides,
  };
}

const realOptions: ChunkOptions = {
  title: 'Guide',
  targetTokens: chunking.targetTokens,
  overlapRatio: chunking.overlapRatio,
  countTokens,
};

const markdown = (text: string): ExtractedContent => ({ kind: 'markdown', markdown: text });

/** `count` numbered sentences of `words` words each: "S3 w w w w." */
function sentences(count: number, words: number, prefix = 'S'): string {
  return Array.from(
    { length: count },
    (_, i) => `${prefix}${i} ${Array.from({ length: words - 1 }, () => 'word').join(' ')}.`,
  ).join(' ');
}

/** Checks what must hold for every chunk list, whatever the input. */
function expectWellFormed(text: string, chunks: Chunk[], count = countWords) {
  chunks.forEach((chunk, index) => {
    expect(chunk.chunkIndex).toBe(index);
    expect(chunk.content).toBe(text.slice(chunk.charStart, chunk.charEnd));
    expect(chunk.content).toBe(chunk.content.trim());
    expect(chunk.content).not.toBe('');
    expect(chunk.tokenCount).toBe(count(chunk.content));
  });
}

describe('chunking: markdown structure', () => {
  const doc = [
    'Opening paragraph before any heading.',
    '',
    '# Basics',
    '',
    'Basics body one. Basics body two.',
    '',
    '## Setup',
    '',
    'Setup body.',
    '',
    '### Details ###',
    '',
    'Details body.',
    '',
    '## Usage',
    '',
    'Usage body.',
    '',
    '# Advanced',
    '',
    'Advanced body.',
  ].join('\n');

  it('never crosses a heading, and records the heading path and context header', () => {
    const { text, chunks } = chunkContent(markdown(doc), options());

    expectWellFormed(text, chunks);
    expect(chunks.map((c) => [c.headingPath, c.content])).toEqual([
      [null, 'Opening paragraph before any heading.'],
      ['Basics', 'Basics body one. Basics body two.'],
      ['Basics › Setup', 'Setup body.'],
      ['Basics › Setup › Details', 'Details body.'],
      ['Basics › Usage', 'Usage body.'],
      ['Advanced', 'Advanced body.'],
    ]);
    expect(chunks.map((c) => c.contextHeader)).toEqual([
      'Guide',
      'Guide › Basics',
      'Guide › Basics › Setup',
      'Guide › Basics › Setup › Details',
      'Guide › Basics › Usage',
      'Guide › Advanced',
    ]);
    expect(chunks.every((c) => c.pageNumber === null && c.startSeconds === null)).toBe(true);
  });

  it('the full text is the markdown itself, so offsets can highlight the original', () => {
    const { text, chunks } = chunkContent(markdown(doc), options());

    expect(text).toBe(doc);
    expect(doc.slice(chunks[2]?.charStart, chunks[2]?.charEnd)).toBe('Setup body.');
  });

  it('a first heading that repeats the title is not repeated in the context header', () => {
    const { chunks } = chunkContent(
      markdown('# My Guide\n\nIntro.\n\n## Install\n\nRun it.'),
      options({ title: 'my guide' }),
    );

    expect(chunks.map((c) => c.contextHeader)).toEqual(['my guide', 'my guide › Install']);
    expect(chunks.map((c) => c.headingPath)).toEqual(['My Guide', 'My Guide › Install']);
  });

  it('a skipped heading level leaves no gap in the path', () => {
    const { chunks } = chunkContent(markdown('# A\n\nOne.\n\n### C\n\nTwo.'), options());

    expect(chunks.map((c) => c.headingPath)).toEqual(['A', 'A › C']);
  });

  it('a `#` line inside a code fence is not a heading', () => {
    const { chunks } = chunkContent(
      markdown('# Script\n\nRun this:\n\n```sh\n# install deps\nnpm i\n```\n\nDone.'),
      options(),
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toBe('Script');
    expect(chunks[0]?.content).toContain('# install deps');
  });

  it('a heading with no text under it makes no chunk', () => {
    const { chunks } = chunkContent(markdown('# A\n\n## B\n\nBody.\n\n## Empty\n'), options());

    expect(chunks.map((c) => c.headingPath)).toEqual(['A › B']);
  });
});

describe('chunking: size and overlap', () => {
  it('packs sentences up to the target and never past it', () => {
    // 40 sentences of 10 words = 400 words, target 50 → 8 chunks of exactly 5 sentences.
    const { text, chunks } = chunkContent(markdown(sentences(40, 10)), options());

    expectWellFormed(text, chunks);
    expect(chunks).toHaveLength(8);
    expect(chunks.every((c) => c.tokenCount === 50)).toBe(true);
    expect(chunks[1]?.content.startsWith('S5 ')).toBe(true);
  });

  it('the next chunk starts with the tail of the previous one (15% overlap)', () => {
    // target 100, overlap 15 tokens → one 10-word sentence is carried over.
    const { text, chunks } = chunkContent(
      markdown(sentences(40, 10)),
      options({ targetTokens: 100, overlapRatio: 0.15 }),
    );

    expectWellFormed(text, chunks);
    expect(chunks[0]?.content.startsWith('S0 ')).toBe(true);
    expect(chunks[0]?.content.includes('S9 ')).toBe(true);
    expect(chunks[1]?.content.startsWith('S9 ')).toBe(true);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(100);
      const previous = chunks[index - 1];
      if (previous) {
        const shared = text.slice(chunk.charStart, previous.charEnd);
        expect(countWords(shared)).toBe(10);
      }
    }
    // Nothing is lost: every sentence is in some chunk.
    for (let i = 0; i < 40; i++) {
      expect(chunks.some((c) => c.content.includes(`S${i} `))).toBe(true);
    }
  });

  it('prefers ending at a paragraph break over splitting the next paragraph', () => {
    // Three 30-word paragraphs, target 50: a second paragraph would not fit, so each stands alone.
    const paragraphs = [sentences(3, 10, 'A'), sentences(3, 10, 'B'), sentences(3, 10, 'C')];
    const { chunks } = chunkContent(markdown(paragraphs.join('\n\n')), options());

    expect(chunks.map((c) => c.content)).toEqual(paragraphs);
  });

  it('small paragraphs are combined into one chunk', () => {
    const { chunks } = chunkContent(markdown('One.\n\nTwo.\n\nThree.'), options());

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('One.\n\nTwo.\n\nThree.');
  });

  it('one giant paragraph with no sentence breaks is cut into word runs that fit', () => {
    const giant = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(' ');
    const { text, chunks } = chunkContent(markdown(giant), options());

    expectWellFormed(text, chunks);
    expect(chunks).toHaveLength(20);
    expect(chunks.every((c) => c.tokenCount <= 50)).toBe(true);
    expect(chunks.map((c) => c.content).join(' ')).toBe(giant);
  });

  it('one giant unbroken string is cut by length, with nothing lost', () => {
    const blob = 'x'.repeat(5000);
    // ~4 characters per token, so the blob is far over the target of 50.
    const { text, chunks } = chunkContent(
      markdown(blob),
      options({ countTokens: (t) => Math.ceil(t.length / 4) }),
    );

    expectWellFormed(text, chunks, (t) => Math.ceil(t.length / 4));
    expect(chunks.length).toBeGreaterThan(20);
    expect(chunks.every((c) => c.tokenCount <= 50)).toBe(true);
    expect(chunks.map((c) => c.content).join('')).toBe(blob);
  });

  it('with the real tokenizer and config: chunks near 500 tokens, overlapping by at most 15%', () => {
    const paragraphs = Array.from({ length: 60 }, (_, p) =>
      Array.from(
        { length: 6 },
        (_, s) =>
          `Paragraph ${p} sentence ${s} explains how gradient descent updates the weights of a model step by step.`,
      ).join(' '),
    );
    const { text, chunks } = chunkContent(markdown(paragraphs.join('\n\n')), realOptions);

    expectWellFormed(text, chunks, countTokens);
    expect(chunks.length).toBeGreaterThan(5);
    const overlapLimit = chunking.targetTokens * chunking.overlapRatio;
    for (const [index, chunk] of chunks.entries()) {
      // Joining sentences adds a few separator tokens on top of the packed total.
      expect(chunk.tokenCount).toBeLessThanOrEqual(chunking.targetTokens * 1.1);
      if (index < chunks.length - 1) {
        expect(chunk.tokenCount).toBeGreaterThanOrEqual(chunking.targetTokens / 2);
      }
      const previous = chunks[index - 1];
      if (previous) {
        const shared = text.slice(chunk.charStart, previous.charEnd);
        expect(shared.length).toBeGreaterThan(0);
        expect(countTokens(shared)).toBeLessThanOrEqual(overlapLimit);
      }
    }
  });
});

describe('chunking: PDF pages', () => {
  const pages: ExtractedContent = {
    kind: 'pages',
    pages: [
      { pageNumber: 1, text: 'Page one text.' },
      { pageNumber: 2, text: '' },
      { pageNumber: 3, text: sentences(12, 10) },
      { pageNumber: 4, text: 'Last page.' },
    ],
  };

  it('never crosses a page; every chunk carries its page number', () => {
    const { text, chunks } = chunkContent(pages, options({ overlapRatio: 0.2 }));

    expectWellFormed(text, chunks);
    expect(chunks.map((c) => c.pageNumber)).toEqual([1, 3, 3, 3, 4]);
    expect(chunks[0]?.content).toBe('Page one text.');
    expect(chunks.at(-1)?.content).toBe('Last page.');
    expect(chunks.every((c) => c.headingPath === null && c.contextHeader === 'Guide')).toBe(true);
  });

  it('overlaps within a page but not across pages', () => {
    const { chunks } = chunkContent(pages, options({ overlapRatio: 0.2 }));
    const [one, threeA, threeB, threeC, four] = chunks;

    // Within page 3, each chunk starts inside the previous one.
    expect(threeB?.charStart).toBeLessThan(threeA?.charEnd ?? 0);
    expect(threeC?.charStart).toBeLessThan(threeB?.charEnd ?? 0);
    // Across pages, no shared text.
    expect(threeA?.charStart).toBeGreaterThanOrEqual(one?.charEnd ?? Infinity);
    expect(four?.charStart).toBeGreaterThanOrEqual(threeC?.charEnd ?? Infinity);
  });

  it('offsets point into the pages joined by a blank line', () => {
    const { text, chunks } = chunkContent(pages, options());

    expect(text).toBe(fullText(pages));
    expect(text.startsWith('Page one text.\n\n\n\nS0 ')).toBe(true);
    expect(text.slice(chunks.at(-1)?.charStart)).toBe('Last page.');
  });
});

describe('chunking: YouTube transcript', () => {
  const transcript: ExtractedContent = {
    kind: 'transcript',
    segments: Array.from({ length: 12 }, (_, i) => ({
      text: `seg${i} ${Array.from({ length: 9 }, () => 'word').join(' ')}`,
      startSeconds: i * 4.5,
      endSeconds: i * 4.5 + 4.2,
    })),
  };

  it('groups caption segments and keeps whole-second start and end times', () => {
    // 12 segments of 10 words, target 50 → 5 segments per chunk.
    const { text, chunks } = chunkContent(transcript, options());

    expectWellFormed(text, chunks);
    expect(chunks.map((c) => [c.startSeconds, c.endSeconds])).toEqual([
      [0, 23], // segments 0–4: 0.0 → 22.2
      [22, 45], // segments 5–9: 22.5 → 44.7
      [45, 54], // segments 10–11: 45.0 → 53.7
    ]);
    expect(chunks.every((c) => c.pageNumber === null && c.headingPath === null)).toBe(true);
    expect(chunks.every((c) => c.contextHeader === 'Guide')).toBe(true);
  });

  it('an overlapping chunk starts at the carried segment’s timestamp', () => {
    const { chunks } = chunkContent(transcript, options({ overlapRatio: 0.2 }));

    // Overlap of 10 tokens = one segment: chunk 2 starts with segment 4.
    expect(chunks[1]?.content.startsWith('seg4 ')).toBe(true);
    expect(chunks[1]?.startSeconds).toBe(18);
  });
});

describe('chunking: edge cases', () => {
  it.each<[string, ExtractedContent]>([
    ['empty markdown', markdown('')],
    ['whitespace-only markdown', markdown(' \n\n \t\n')],
    ['headings only', markdown('# A\n\n## B\n')],
    ['pages with no text', { kind: 'pages', pages: [{ pageNumber: 1, text: '' }] }],
    ['no pages', { kind: 'pages', pages: [] }],
    ['no caption segments', { kind: 'transcript', segments: [] }],
  ])('%s → no chunks', (_label, content) => {
    expect(chunkContent(content, options()).chunks).toEqual([]);
  });

  it('is deterministic: the same input gives the same chunks', () => {
    const content = markdown(`# T\n\n${sentences(30, 10)}\n\n## U\n\n${sentences(30, 10, 'U')}`);
    const config = options({ overlapRatio: 0.15 });

    expect(chunkContent(content, config)).toEqual(chunkContent(content, config));
  });

  it('handles Windows line endings and non-Latin text', () => {
    const { text, chunks } = chunkContent(
      markdown('# 概要\r\n\r\n这是第一段。\r\n\r\n## Détails\r\n\r\nTexte accentué.'),
      options({ title: 'Doc' }),
    );

    expectWellFormed(text, chunks);
    expect(chunks.map((c) => [c.contextHeader, c.content])).toEqual([
      ['Doc › 概要', '这是第一段。'],
      ['Doc › 概要 › Détails', 'Texte accentué.'],
    ]);
  });
});
