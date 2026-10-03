import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { datasetDir } from './dataset.js';

/** `dataset/paths.json`: the learning-path eval topics (test plan §6.3). */
const pathTopicSchema = z.object({
  id: z.string(),
  topic: z.string(),
  goal: z.enum(['EXAM', 'JOB', 'CURIOSITY']),
  officialSource: z.string().nullable(),
  sections: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).min(1),
});
export type PathTopic = z.infer<typeof pathTopicSchema>;

const pathsDatasetSchema = z.object({ topics: z.array(pathTopicSchema).min(1) });

export async function readPathTopics(): Promise<PathTopic[]> {
  const raw: unknown = JSON.parse(await readFile(`${datasetDir}paths.json`, 'utf8'));
  return pathsDatasetSchema.parse(raw).topics;
}

/** The coverage judge's reply (`judges/path-coverage.md`). */
export const coverageVerdictSchema = z.object({
  sections: z.array(
    z.object({ index: z.number().int(), covered: z.boolean(), concept: z.string().nullable() }),
  ),
});
export type CoverageVerdict = z.infer<typeof coverageVerdictSchema>;

/**
 * Core sections covered ÷ core sections. Judged by number (1-based); a section the judge left out
 * counts as not covered, and an index out of range is ignored.
 */
export function coverage(verdict: CoverageVerdict, sectionCount: number) {
  const covered = new Set(
    verdict.sections
      .filter((s) => s.covered && s.index >= 1 && s.index <= sectionCount)
      .map((s) => s.index),
  );
  return {
    covered: covered.size,
    total: sectionCount,
    rate: sectionCount === 0 ? 0 : round(covered.size / sectionCount),
    coveredIndexes: [...covered].sort((a, b) => a - b),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export const normalizeConcept = (name: string) =>
  name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Jaccard of two concept-name sets, compared by normalized name. */
export function exactJaccard(a: string[], b: string[]): number {
  const left = new Set(a.map(normalizeConcept));
  const right = new Set(b.map(normalizeConcept));
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  const shared = [...left].filter((name) => right.has(name)).length;
  return round(shared / union.size);
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

/**
 * Jaccard where two concepts are "the same" when their name embeddings are at least `threshold`
 * similar ("Backprop" ≈ "Backpropagation"): pairs are matched greedily, most similar first, each
 * concept at most once. matches ÷ (|A| + |B| − matches).
 */
export function semanticJaccard(a: number[][], b: number[][], threshold: number): number {
  if (a.length === 0 && b.length === 0) return 1;
  const pairs: { i: number; j: number; s: number }[] = [];
  a.forEach((x, i) =>
    b.forEach((y, j) => {
      const s = cosine(x, y);
      if (s >= threshold) pairs.push({ i, j, s });
    }),
  );
  pairs.sort((p, q) => q.s - p.s || p.i - q.i || p.j - q.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  let matches = 0;
  for (const { i, j } of pairs) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    matches += 1;
  }
  return round(matches / (a.length + b.length - matches));
}

/** The mean of `score` over every pair of runs (3 runs → 3 pairs). */
export function pairwiseMean<T>(runs: T[], score: (a: T, b: T) => number): number | null {
  const scores: number[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const a = runs[i];
      const b = runs[j];
      if (a !== undefined && b !== undefined) scores.push(score(a, b));
    }
  }
  return scores.length === 0 ? null : round(scores.reduce((s, n) => s + n, 0) / scores.length);
}
