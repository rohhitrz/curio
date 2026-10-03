import { describe, expect, it } from 'vitest';
import {
  coverage,
  exactJaccard,
  normalizeConcept,
  pairwiseMean,
  readPathTopics,
  semanticJaccard,
} from './paths.js';

describe('paths dataset', () => {
  it('parses; ids are unique; each topic has 8+ core sections', async () => {
    const topics = await readPathTopics();
    expect(topics).toHaveLength(3);
    expect(new Set(topics.map((t) => t.id)).size).toBe(3);
    for (const topic of topics) {
      expect(topic.sections.length).toBeGreaterThanOrEqual(8);
      expect(new Set(topic.sections.map((s) => s.id)).size).toBe(topic.sections.length);
    }
    expect(topics.some((t) => t.officialSource === null)).toBe(true);
  });
});

describe('coverage', () => {
  it('covered sections ÷ all; missing and out-of-range entries ignored; repeats counted once', () => {
    const result = coverage(
      {
        sections: [
          { index: 1, covered: true, concept: 'A' },
          { index: 2, covered: false, concept: null },
          { index: 3, covered: true, concept: 'C' },
          { index: 3, covered: true, concept: 'C again' },
          { index: 9, covered: true, concept: 'X' },
        ],
      },
      4,
    );

    expect(result).toEqual({ covered: 2, total: 4, rate: 0.5, coveredIndexes: [1, 3] });
  });
});

describe('consistency', () => {
  it('exact Jaccard compares normalized names', () => {
    expect(normalizeConcept('  Gradient-Descent! ')).toBe('gradient descent');
    expect(exactJaccard(['Loops', 'Strings', 'Lists'], ['loops', 'strings!', 'Classes'])).toBe(0.5);
    expect(exactJaccard([], [])).toBe(1);
  });

  it('semantic Jaccard matches similar names once each, most similar first', () => {
    const v = (x: number, y: number) => [x, y];
    // a0 ≈ b0 (identical), a1 ≈ b1 (close), a2 matches nothing.
    const a = [v(1, 0), v(0, 1), v(-1, 0)];
    const b = [v(1, 0), v(0.1, 1)];

    expect(semanticJaccard(a, b, 0.9)).toBe(0.667);
    expect(semanticJaccard(a, b, 0.9999)).toBe(0.25);
    // One concept can't match two.
    expect(semanticJaccard([v(1, 0)], [v(1, 0), v(1, 0.01)], 0.9)).toBe(0.5);
    expect(semanticJaccard([], [], 0.9)).toBe(1);
  });

  it('pairwise mean over every pair of runs', () => {
    expect(pairwiseMean([1, 2, 3], (a, b) => a + b)).toBe(4);
    expect(pairwiseMean([1], (a, b) => a + b)).toBeNull();
  });
});
