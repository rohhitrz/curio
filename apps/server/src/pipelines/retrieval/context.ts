import type { RetrievedChunk } from './retrieve.js';

/** One numbered source in the prompt: `[marker]` in the answer points back to `chunk`. */
export interface ContextSource {
  marker: number;
  chunk: RetrievedChunk;
}

export interface Context {
  sources: ContextSource[];
  /** The numbered sources as the model reads them. */
  text: string;
}

export interface ContextOptions {
  maxTokens: number;
  countTokens: (text: string) => number;
}

function formatSeconds(total: number): string {
  const seconds = Math.floor(total % 60);
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

/** Where the passage is, in words the model can repeat ("page 12", "at 4:05"). */
export function locationLabel(chunk: RetrievedChunk): string | null {
  const { pageNumber, startSeconds, headingPath } = chunk.location;
  if (pageNumber !== null) return `page ${pageNumber}`;
  if (startSeconds !== null) return `at ${formatSeconds(startSeconds)}`;
  return headingPath;
}

function formatSource(marker: number, chunk: RetrievedChunk): string {
  const location = locationLabel(chunk);
  const heading = `[${marker}] ${chunk.sourceTitle}${location ? ` (${location})` : ''}`;
  return `${heading}\n${chunk.content.trim()}`;
}

/**
 * Numbers the chunks [1] [2]… in the order given (best first), skipping duplicates, and stops
 * before the token budget is passed. The first chunk is always kept, even if it alone is over.
 */
export function buildContext(chunks: RetrievedChunk[], options: ContextOptions): Context {
  const seen = new Set<string>();
  const sources: ContextSource[] = [];
  const blocks: string[] = [];
  let tokens = 0;

  for (const chunk of chunks) {
    if (seen.has(chunk.chunkId)) continue;
    const block = formatSource(sources.length + 1, chunk);
    const blockTokens = options.countTokens(block);
    if (sources.length > 0 && tokens + blockTokens > options.maxTokens) break;
    seen.add(chunk.chunkId);
    sources.push({ marker: sources.length + 1, chunk });
    blocks.push(block);
    tokens += blockTokens;
  }

  return { sources, text: blocks.join('\n\n') };
}
