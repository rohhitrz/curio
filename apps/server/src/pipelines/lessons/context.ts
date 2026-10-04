import { locationLabel, type ContextSource } from '../retrieval/context.js';
import type { RetrievedChunk } from '../retrieval/retrieve.js';
import type { ConceptPassages, LessonConcept } from './retrieve.js';

export interface LessonConceptContext {
  concept: LessonConcept;
  /** The passage numbers kept for it; empty → taught as general knowledge (L-10). */
  markers: number[];
}

export interface LessonContext {
  concepts: LessonConceptContext[];
  sources: ContextSource[];
  /** The numbered passages as the model reads them. */
  text: string;
}

function formatSource(marker: number, chunk: RetrievedChunk): string {
  const location = locationLabel(chunk);
  return `[${marker}] ${chunk.sourceTitle}${location ? ` (${location})` : ''}\n${chunk.content.trim()}`;
}

/**
 * Numbers the passages for a lesson (pure). Concepts take turns: every concept's best passage,
 * then every concept's second, and so on, until the token budget is reached, so no concept is
 * crowded out by another's long passages. A passage found for two concepts is numbered once and
 * listed under both. The first round always fits: a covered concept never loses its best passage.
 */
export function buildLessonContext(
  passages: ConceptPassages[],
  options: { maxTokens: number; countTokens: (text: string) => number },
): LessonContext {
  const markerOf = new Map<string, number>();
  const sources: ContextSource[] = [];
  const blocks: string[] = [];
  const kept = passages.map(() => [] as number[]);
  let tokens = 0;
  let full = false;
  const rounds = Math.max(0, ...passages.map((p) => p.chunks.length));

  for (let round = 0; round < rounds && !full; round++) {
    for (const [i, { chunks }] of passages.entries()) {
      const chunk = chunks[round];
      if (!chunk) continue;
      const known = markerOf.get(chunk.chunkId);
      if (known !== undefined) {
        if (!kept[i]?.includes(known)) kept[i]?.push(known);
        continue;
      }
      const marker = sources.length + 1;
      const block = formatSource(marker, chunk);
      const blockTokens = options.countTokens(block);
      if (round > 0 && tokens + blockTokens > options.maxTokens) {
        full = true;
        break;
      }
      markerOf.set(chunk.chunkId, marker);
      sources.push({ marker, chunk });
      blocks.push(block);
      kept[i]?.push(marker);
      tokens += blockTokens;
    }
  }

  return {
    concepts: passages.map(({ concept }, i) => ({ concept, markers: kept[i] ?? [] })),
    sources,
    text: blocks.join('\n\n'),
  };
}
