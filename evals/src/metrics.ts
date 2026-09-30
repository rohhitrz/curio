/** What retrieval returned for one question, reduced to what the metrics need. */
export interface QuestionOutcome {
  category: string;
  answerable: boolean;
  /** 1-based ranks of the retrieved chunks that are at an expected location, ascending. */
  relevantRanks: number[];
}

export interface RetrievalMetrics {
  /** Answerable questions the numbers are computed over. */
  questions: number;
  /** Keyed `hitRate@<k>`: share of answerable questions with a relevant chunk in the top k. */
  hitRate: Record<string, number>;
  /** Mean of 1 / rank of the first relevant chunk (0 when none was retrieved). */
  mrr: number;
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Hit rate@k and MRR over the answerable questions (test plan §6.3). Unanswerable questions
 * have no relevant chunk by definition, so they don't count here; refusal accuracy covers them
 * in Phase 5. MRR only sees what was retrieved (the top `max(ks)`).
 */
export function retrievalMetrics(
  outcomes: QuestionOutcome[],
  ks: readonly number[],
): RetrievalMetrics {
  const answerable = outcomes.filter((outcome) => outcome.answerable);
  const n = answerable.length;
  const firstRanks = answerable.map((outcome) => outcome.relevantRanks[0] ?? null);

  const hitRate: Record<string, number> = {};
  for (const k of ks) {
    const hits = firstRanks.filter((rank) => rank !== null && rank <= k).length;
    hitRate[`hitRate@${String(k)}`] = n === 0 ? 0 : round(hits / n);
  }
  const reciprocal = firstRanks.reduce<number>(
    (sum, rank) => sum + (rank === null ? 0 : 1 / rank),
    0,
  );

  return { questions: n, hitRate, mrr: n === 0 ? 0 : round(reciprocal / n) };
}

/** The same metrics per category, for the categories that have answerable questions. */
export function metricsByCategory(
  outcomes: QuestionOutcome[],
  ks: readonly number[],
): Record<string, RetrievalMetrics> {
  const categories = [...new Set(outcomes.filter((o) => o.answerable).map((o) => o.category))];
  return Object.fromEntries(
    categories.map((category) => [
      category,
      retrievalMetrics(
        outcomes.filter((outcome) => outcome.category === category),
        ks,
      ),
    ]),
  );
}
