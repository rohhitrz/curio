import type { ExtractedContent } from './extract.js';

export interface ChunkOptions {
  /** The source's title, used in every chunk's context header. */
  title: string;
  /** Aim for chunks of about this many tokens; a chunk's units never add up to more. */
  targetTokens: number;
  /** Share of `targetTokens` repeated at the start of the next chunk (0 = no overlap). */
  overlapRatio: number;
  countTokens: (text: string) => number;
}

export interface Chunk {
  chunkIndex: number;
  /** An exact slice of the full text: `text.slice(charStart, charEnd)`. */
  content: string;
  /** "Title › Section", prepended before embedding and indexed for keyword search. */
  contextHeader: string;
  tokenCount: number;
  /** PDF only. */
  pageNumber: number | null;
  /** YouTube only, whole seconds. */
  startSeconds: number | null;
  endSeconds: number | null;
  /** Website / text only: "Heading › Subheading", or null before the first heading. */
  headingPath: string | null;
  charStart: number;
  charEnd: number;
}

export interface ChunkedSource {
  /** The source's full text. Chunk offsets point into it. */
  text: string;
  chunks: Chunk[];
}

const HEADER_SEPARATOR = ' › ';
const PAGE_SEPARATOR = '\n\n';
const SEGMENT_SEPARATOR = ' ';

/** The smallest piece a chunk is built from: a sentence, a line, or one caption segment. */
interface Unit {
  start: number;
  end: number;
  tokens: number;
  /** First unit of a paragraph: a good place to end the previous chunk. */
  startsParagraph: boolean;
  startSeconds?: number;
  endSeconds?: number;
}

/** A run of units that chunks must not cross: one PDF page, one section, one transcript. */
interface Group {
  units: Unit[];
  pageNumber: number | null;
  headingPath: string | null;
}

type Counter = (text: string) => number;

/** `[start, end)` without surrounding whitespace, or null when nothing is left. */
function trimRange(text: string, start: number, end: number): [number, number] | null {
  while (start < end && /\s/.test(text.charAt(start))) start++;
  while (end > start && /\s/.test(text.charAt(end - 1))) end--;
  return start < end ? [start, end] : null;
}

/**
 * Cuts a piece that alone is over the target (a sentence with no breaks, a huge table row) into
 * word runs that fit. A single "word" that is still too big is cut by length.
 */
function splitOversized(text: string, start: number, end: number, target: number, count: Counter) {
  const pieces: [number, number][] = [];
  let pieceStart = -1;
  let pieceEnd = -1;
  let tokens = 0;
  const flush = () => {
    if (pieceStart >= 0) pieces.push([pieceStart, pieceEnd]);
    pieceStart = -1;
    tokens = 0;
  };

  for (const match of text.slice(start, end).matchAll(/\S+/g)) {
    const wordStart = start + match.index;
    const wordEnd = wordStart + match[0].length;
    // A leading space is part of how a word is tokenized mid-sentence.
    const wordTokens = count(` ${match[0]}`);

    if (wordTokens > target) {
      flush();
      const step = Math.max(1, Math.floor(match[0].length / Math.ceil(wordTokens / target)));
      for (let at = wordStart; at < wordEnd; at += step) {
        pieces.push([at, Math.min(at + step, wordEnd)]);
      }
      continue;
    }
    if (pieceStart >= 0 && tokens + wordTokens > target) flush();
    if (pieceStart < 0) pieceStart = wordStart;
    pieceEnd = wordEnd;
    tokens += wordTokens;
  }
  flush();
  return pieces;
}

/** Splits `[start, end)` into units: paragraphs → sentences and lines → (if needed) word runs. */
function toUnits(text: string, start: number, end: number, target: number, count: Counter): Unit[] {
  const units: Unit[] = [];
  const body = text.slice(start, end);

  let paragraphStart = 0;
  const paragraphEnds = [...body.matchAll(/\n[ \t\r]*\n\s*/g), null];
  for (const paragraphBreak of paragraphEnds) {
    const paragraphEnd = paragraphBreak ? paragraphBreak.index : body.length;
    const paragraph = body.slice(paragraphStart, paragraphEnd);
    let first = true;

    let pieceStart = 0;
    // A piece ends after sentence punctuation followed by space, or at a line break.
    const pieceEnds = [...paragraph.matchAll(/(?<=[.!?]["')\]]*)[ \t]+|\n+/g), null];
    for (const pieceBreak of pieceEnds) {
      const pieceEnd = pieceBreak ? pieceBreak.index : paragraph.length;
      const range = trimRange(
        text,
        start + paragraphStart + pieceStart,
        start + paragraphStart + pieceEnd,
      );
      if (range) {
        const tokens = count(text.slice(range[0], range[1]));
        const ranges =
          tokens > target ? splitOversized(text, range[0], range[1], target, count) : [range];
        for (const [unitStart, unitEnd] of ranges) {
          units.push({
            start: unitStart,
            end: unitEnd,
            tokens: ranges.length === 1 ? tokens : count(text.slice(unitStart, unitEnd)),
            startsParagraph: first,
          });
          first = false;
        }
      }
      if (pieceBreak) pieceStart = pieceBreak.index + pieceBreak[0].length;
    }
    if (paragraphBreak) paragraphStart = paragraphBreak.index + paragraphBreak[0].length;
  }
  return units;
}

/** Splits markdown into sections at its headings (`#` … `######`), ignoring fenced code. */
function markdownGroups(text: string, target: number, count: Counter): Group[] {
  const groups: Group[] = [];
  const path: string[] = [];
  let sectionStart = 0;
  let headingPath: string | null = null;
  let fence: string | null = null;

  const closeSection = (end: number) => {
    const units = toUnits(text, sectionStart, end, target, count);
    if (units.length > 0) groups.push({ units, pageNumber: null, headingPath });
  };

  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    // Without a trailing `\r`, so Windows line endings don't hide headings.
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');

    const fenceMatch = /^ {0,3}(```+|~~~+)/.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1].charAt(0);
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }

    const heading =
      fence === null ? /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line) : null;
    const headingText = heading?.[2]?.trim();
    if (heading?.[1] && headingText) {
      closeSection(lineStart);
      const level = heading[1].length;
      path.length = Math.min(path.length, level - 1);
      // A skipped level (h1 → h3) leaves no gap in the path.
      path.push(headingText);
      headingPath = path.join(HEADER_SEPARATOR);
      sectionStart = lineEnd;
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }
  closeSection(text.length);
  return groups;
}

/** The full text of a source, the one chunk offsets refer to. */
export function fullText(content: ExtractedContent): string {
  switch (content.kind) {
    case 'markdown':
      return content.markdown;
    case 'pages':
      return content.pages.map((page) => page.text).join(PAGE_SEPARATOR);
    case 'transcript':
      return content.segments.map((segment) => segment.text).join(SEGMENT_SEPARATOR);
  }
}

function toGroups(
  content: ExtractedContent,
  text: string,
  target: number,
  count: Counter,
): Group[] {
  switch (content.kind) {
    case 'markdown':
      return markdownGroups(text, target, count);

    case 'pages': {
      const groups: Group[] = [];
      let offset = 0;
      for (const page of content.pages) {
        const units = toUnits(text, offset, offset + page.text.length, target, count);
        if (units.length > 0) {
          groups.push({ units, pageNumber: page.pageNumber, headingPath: null });
        }
        offset += page.text.length + PAGE_SEPARATOR.length;
      }
      return groups;
    }

    case 'transcript': {
      const units: Unit[] = [];
      let offset = 0;
      for (const segment of content.segments) {
        const start = offset;
        const end = offset + segment.text.length;
        offset = end + SEGMENT_SEPARATOR.length;
        // Captions are short; an unusually long one is cut, each piece keeping its times.
        const tokens = count(segment.text);
        const ranges: [number, number][] =
          tokens > target ? splitOversized(text, start, end, target, count) : [[start, end]];
        for (const [unitStart, unitEnd] of ranges) {
          if (unitStart === unitEnd) continue;
          units.push({
            start: unitStart,
            end: unitEnd,
            tokens: ranges.length === 1 ? tokens : count(text.slice(unitStart, unitEnd)),
            startsParagraph: false,
            startSeconds: segment.startSeconds,
            endSeconds: segment.endSeconds,
          });
        }
      }
      return units.length > 0 ? [{ units, pageNumber: null, headingPath: null }] : [];
    }
  }
}

/**
 * Packs a group's units into runs of at most `target` tokens. Each run after the first starts
 * with the tail of the previous one (up to `overlap` tokens), so an idea cut at a chunk edge is
 * whole in one of the two.
 */
function pack(units: Unit[], target: number, overlap: number): Unit[][] {
  const runs: Unit[][] = [];
  let run: Unit[] = [];
  let tokens = 0;
  /** How many units at the start of `run` were carried over from the previous run. */
  let carried = 0;

  /** Tokens of the paragraph that starts at `index`. */
  const paragraphTokens = (index: number) => {
    let total = 0;
    for (let i = index; i < units.length; i++) {
      const unit = units[i];
      if (!unit || (i > index && unit.startsParagraph)) break;
      total += unit.tokens;
    }
    return total;
  };

  const close = () => {
    runs.push(run);
    const tail: Unit[] = [];
    let tailTokens = 0;
    for (let i = run.length - 1; i > 0; i--) {
      const unit = run[i];
      if (!unit || tailTokens + unit.tokens > overlap) break;
      tail.unshift(unit);
      tailTokens += unit.tokens;
    }
    run = tail;
    tokens = tailTokens;
    carried = tail.length;
  };

  for (const [index, unit] of units.entries()) {
    const hasNew = run.length > carried;
    if (hasNew) {
      const full = tokens + unit.tokens > target;
      // Structure first: rather than split the next paragraph, end here when the chunk is
      // already at least half full and the whole paragraph wouldn't fit.
      const breakAtParagraph =
        unit.startsParagraph && tokens >= target / 2 && tokens + paragraphTokens(index) > target;
      if (full || breakAtParagraph) close();
    }
    // The carried tail plus a large unit can overshoot; drop the tail rather than the limit.
    while (run.length > 0 && run.length === carried && tokens + unit.tokens > target) {
      const dropped = run.shift();
      tokens -= dropped?.tokens ?? 0;
      carried--;
    }
    run.push(unit);
    tokens += unit.tokens;
  }
  if (run.length > carried) runs.push(run);
  return runs;
}

/** "Title › Section", without repeating a first heading that is just the title again. */
function contextHeader(title: string, headingPath: string | null): string {
  if (headingPath === null) return title;
  const [first, ...rest] = headingPath.split(HEADER_SEPARATOR);
  const sameAsTitle = first?.trim().toLowerCase() === title.trim().toLowerCase();
  const path = sameAsTitle ? rest : [first, ...rest];
  return [title, ...path].join(HEADER_SEPARATOR);
}

/**
 * Splits extracted content into chunks for embedding. Pure: the same input always gives the same
 * chunks.
 *
 * Structure comes first: a chunk never crosses a PDF page or a markdown heading, so it can be
 * cited to one place. Within those bounds, sentences and lines are packed up to `targetTokens`,
 * with an overlap between neighbours.
 */
export function chunkContent(content: ExtractedContent, options: ChunkOptions): ChunkedSource {
  const { title, targetTokens, countTokens } = options;
  const overlapTokens = Math.floor(targetTokens * options.overlapRatio);
  const text = fullText(content);

  const chunks: Chunk[] = [];
  for (const group of toGroups(content, text, targetTokens, countTokens)) {
    for (const run of pack(group.units, targetTokens, overlapTokens)) {
      const first = run[0];
      const last = run[run.length - 1];
      if (!first || !last) continue;

      const chunkText = text.slice(first.start, last.end);
      chunks.push({
        chunkIndex: chunks.length,
        content: chunkText,
        contextHeader: contextHeader(title, group.headingPath),
        tokenCount: countTokens(chunkText),
        pageNumber: group.pageNumber,
        startSeconds: first.startSeconds === undefined ? null : Math.floor(first.startSeconds),
        endSeconds: last.endSeconds === undefined ? null : Math.ceil(last.endSeconds),
        headingPath: group.headingPath,
        charStart: first.start,
        charEnd: last.end,
      });
    }
  }
  return { text, chunks };
}
