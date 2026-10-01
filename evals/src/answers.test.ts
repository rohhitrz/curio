import { describe, expect, it } from 'vitest';
import {
  answerMetrics,
  answerMetricsByCategory,
  averageMetrics,
  usageCost,
  type AnswerOutcome,
} from './answers.js';

function outcome(overrides: Partial<AnswerOutcome> = {}): AnswerOutcome {
  return {
    category: 'factual',
    answerable: true,
    refused: false,
    claims: [{ supported: true }],
    correctness: 5,
    citations: [{ relevant: true }],
    ...overrides,
  };
}

describe('answerMetrics', () => {
  it('computes every metric from its own population', () => {
    const metrics = answerMetrics([
      outcome({ claims: [{ supported: true }, { supported: false }], correctness: 5 }),
      outcome({ claims: [{ supported: true }], correctness: 3, citations: [{ relevant: false }] }),
      // Answerable but refused: a false refusal, scored low, no claims.
      outcome({ refused: true, claims: null, correctness: 1, citations: [] }),
      // Unanswerable, refused correctly.
      outcome({
        category: 'unanswerable',
        answerable: false,
        refused: true,
        claims: null,
        correctness: null,
        citations: [],
      }),
      // Unanswerable but answered: its claims still count for faithfulness, its citations don't
      // count for citation accuracy.
      outcome({
        category: 'unanswerable',
        answerable: false,
        claims: [{ supported: false }],
        correctness: null,
        citations: [{ relevant: false }],
      }),
    ]);

    expect(metrics).toEqual({
      faithfulness: 0.5, // 2 supported of 4 claims
      correctness: 3, // (5 + 3 + 1) / 3
      correctnessAtLeast4: 0.3333,
      citationAccuracy: 0.5, // answerable only: 1 of 2
      refusalAccuracy: 0.5,
      falseRefusalRate: 0.3333,
    });
  });

  it('a metric with nothing to measure is null', () => {
    expect(answerMetrics([outcome()])).toMatchObject({ refusalAccuracy: null });
    expect(answerMetrics([])).toEqual({
      faithfulness: null,
      correctness: null,
      correctnessAtLeast4: null,
      citationAccuracy: null,
      refusalAccuracy: null,
      falseRefusalRate: null,
    });
  });

  it('splits by category', () => {
    const byCategory = answerMetricsByCategory([
      outcome(),
      outcome({
        category: 'unanswerable',
        answerable: false,
        refused: true,
        claims: null,
        correctness: null,
        citations: [],
      }),
    ]);

    expect(Object.keys(byCategory)).toEqual(['factual', 'unanswerable']);
    expect(byCategory.unanswerable?.refusalAccuracy).toBe(1);
  });
});

describe('averageMetrics', () => {
  it('averages each metric over the runs that have it', () => {
    const a = answerMetrics([outcome({ correctness: 5 })]);
    const b = answerMetrics([outcome({ correctness: 4, claims: [{ supported: false }] })]);

    expect(averageMetrics([a, b])).toMatchObject({
      correctness: 4.5,
      faithfulness: 0.5,
      refusalAccuracy: null,
    });
  });
});

describe('usageCost', () => {
  it('bills cached input at the cached rate', () => {
    const cost = usageCost(
      { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 },
      { input: 2, cachedInput: 0.1, output: 10 },
    );

    expect(cost).toBeCloseTo(0.6 * 2 + 0.4 * 0.1 + 0.1 * 10, 6);
  });
});
