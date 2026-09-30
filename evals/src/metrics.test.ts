import { describe, expect, it } from 'vitest';
import { metricsByCategory, retrievalMetrics, type QuestionOutcome } from './metrics.js';

const answered = (category: string, ...relevantRanks: number[]): QuestionOutcome => ({
  category,
  answerable: true,
  relevantRanks,
});
const unanswerable: QuestionOutcome = {
  category: 'unanswerable',
  answerable: false,
  relevantRanks: [],
};

describe('retrievalMetrics', () => {
  it('hit rate@k counts questions whose first relevant chunk is within k', () => {
    const outcomes = [answered('factual', 1), answered('factual', 7), answered('factual')];

    const { hitRate, questions } = retrievalMetrics(outcomes, [5, 10]);

    expect(questions).toBe(3);
    expect(hitRate).toEqual({ 'hitRate@5': 0.3333, 'hitRate@10': 0.6667 });
  });

  it('a hit exactly at rank k counts', () => {
    expect(retrievalMetrics([answered('factual', 5)], [5]).hitRate['hitRate@5']).toBe(1);
    expect(retrievalMetrics([answered('factual', 6)], [5]).hitRate['hitRate@5']).toBe(0);
  });

  it('MRR averages 1 / first relevant rank, with 0 for a miss', () => {
    // (1/1 + 1/4 + 0) / 3
    const { mrr } = retrievalMetrics(
      [answered('factual', 1, 3), answered('factual', 4, 9), answered('factual')],
      [10],
    );
    expect(mrr).toBe(0.4167);
  });

  it('ignores unanswerable questions', () => {
    const withUnanswerable = retrievalMetrics([answered('factual', 2), unanswerable], [5]);
    expect(withUnanswerable).toEqual(retrievalMetrics([answered('factual', 2)], [5]));
  });

  it('returns zeros, not NaN, when nothing is answerable', () => {
    expect(retrievalMetrics([unanswerable], [5, 10])).toEqual({
      questions: 0,
      hitRate: { 'hitRate@5': 0, 'hitRate@10': 0 },
      mrr: 0,
    });
  });
});

describe('metricsByCategory', () => {
  it('splits by category and leaves out categories with nothing answerable', () => {
    const byCategory = metricsByCategory(
      [answered('factual', 1), answered('exact-term'), answered('exact-term', 2), unanswerable],
      [5],
    );

    expect(Object.keys(byCategory).sort()).toEqual(['exact-term', 'factual']);
    expect(byCategory.factual).toEqual({ questions: 1, hitRate: { 'hitRate@5': 1 }, mrr: 1 });
    expect(byCategory['exact-term']).toEqual({
      questions: 2,
      hitRate: { 'hitRate@5': 0.5 },
      mrr: 0.25,
    });
  });
});
