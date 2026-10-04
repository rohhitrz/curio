import type { RetrievalFlags } from '../../config/index.js';
import {
  runRetrieval,
  type RetrievalPipelineDeps,
  type RetrievalPipelineResult,
} from '../retrieval/pipeline.js';
import type { RetrievedChunk } from '../retrieval/retrieve.js';

/** A concept the lesson teaches, in the module's order. */
export interface LessonConcept {
  id: string;
  name: string;
  description: string;
}

export interface ConceptPassages {
  concept: LessonConcept;
  /** Best first; empty when nothing relevant was found (the gate refused, or no results). */
  chunks: RetrievedChunk[];
}

/**
 * Lesson retrieval: the same flags as chat, minus query understanding and HyDE. A concept is
 * already a standalone search, so there is nothing to rewrite.
 */
export function lessonFlags(flags: RetrievalFlags): RetrievalFlags {
  return { ...flags, queryRewrite: false, subQueries: false, hyde: false };
}

/** The search for one concept: its name, then what it means in this path. */
export function conceptQuery(concept: LessonConcept): string {
  const description = concept.description.trim();
  return description ? `${concept.name}: ${description}` : concept.name;
}

/** Runs `fn` over `items`, at most `limit` at once, keeping the input order. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * One retrieval per concept in this notebook's sources (docs/02-system-design.md §9): search →
 * fusion → rerank → relevance gate. A gated concept comes back with no passages: the lesson
 * teaches it as general knowledge (L-10). A search error fails the lesson (as it fails chat).
 */
export async function retrieveForConcepts(
  input: {
    userId: string;
    notebookId: string;
    concepts: LessonConcept[];
    chunksPerConcept: number;
    concurrency: number;
  },
  deps: RetrievalPipelineDeps,
): Promise<{ passages: ConceptPassages[]; results: RetrievalPipelineResult[] }> {
  const pipelineDeps = { ...deps, flags: lessonFlags(deps.flags) };
  const results = await mapLimited(input.concepts, input.concurrency, (concept) =>
    runRetrieval(
      {
        userId: input.userId,
        notebookId: input.notebookId,
        question: conceptQuery(concept),
        history: [],
        topK: input.chunksPerConcept,
      },
      pipelineDeps,
    ),
  );
  return {
    passages: input.concepts.map((concept, i) => ({ concept, chunks: results[i]?.chunks ?? [] })),
    results,
  };
}
