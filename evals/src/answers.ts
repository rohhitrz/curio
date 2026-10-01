import { z } from 'zod';

/** What the faithfulness judge returns (`judges/faithfulness.md`). */
export const faithfulnessVerdictSchema = z.object({
  claims: z.array(z.object({ claim: z.string(), supported: z.boolean(), reason: z.string() })),
});
export type FaithfulnessVerdict = z.infer<typeof faithfulnessVerdictSchema>;

/** What the correctness judge returns (`judges/correctness.md`). */
export const correctnessVerdictSchema = z.object({
  score: z.number().int().min(1).max(5),
  reason: z.string(),
});
export type CorrectnessVerdict = z.infer<typeof correctnessVerdictSchema>;

/** One question's answer in one run, reduced to what the answer metrics need. */
export interface AnswerOutcome {
  category: string;
  answerable: boolean;
  /** The "not in your sources" reply. */
  refused: boolean;
  /** Judged claims; null when there was nothing to judge (a refusal). */
  claims: { supported: boolean }[] | null;
  /** Correctness 1–5; null for unanswerable questions. */
  correctness: number | null;
  /** One entry per citation: does it point at an expected location? */
  citations: { relevant: boolean }[];
}

export interface AnswerMetrics {
  /** Supported claims ÷ all claims, over answers that weren't refusals. */
  faithfulness: number | null;
  /** Mean judge score (1–5) over answerable questions. */
  correctness: number | null;
  /** Share of answerable questions scoring ≥ 4. */
  correctnessAtLeast4: number | null;
  /** Citations at an expected location ÷ all citations, over answerable questions. */
  citationAccuracy: number | null;
  /** Unanswerable questions refused ÷ unanswerable questions. */
  refusalAccuracy: number | null;
  /** Answerable questions refused ÷ answerable questions. */
  falseRefusalRate: number | null;
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;
const ratio = (part: number, whole: number) => (whole === 0 ? null : round(part / whole));

/** Test plan §6.3. A metric with nothing to measure (e.g. no unanswerable questions) is null. */
export function answerMetrics(outcomes: AnswerOutcome[]): AnswerMetrics {
  const answerable = outcomes.filter((o) => o.answerable);
  const unanswerable = outcomes.filter((o) => !o.answerable);
  const claims = outcomes.flatMap((o) => (o.refused ? [] : (o.claims ?? [])));
  const scores = answerable.flatMap((o) => (o.correctness === null ? [] : [o.correctness]));
  const citations = answerable.flatMap((o) => o.citations);

  return {
    faithfulness: ratio(claims.filter((c) => c.supported).length, claims.length),
    correctness: ratio(
      scores.reduce((sum, s) => sum + s, 0),
      scores.length,
    ),
    correctnessAtLeast4: ratio(scores.filter((s) => s >= 4).length, scores.length),
    citationAccuracy: ratio(citations.filter((c) => c.relevant).length, citations.length),
    refusalAccuracy: ratio(unanswerable.filter((o) => o.refused).length, unanswerable.length),
    falseRefusalRate: ratio(answerable.filter((o) => o.refused).length, answerable.length),
  };
}

/** The same metrics per category. */
export function answerMetricsByCategory(outcomes: AnswerOutcome[]): Record<string, AnswerMetrics> {
  const categories = [...new Set(outcomes.map((o) => o.category))];
  return Object.fromEntries(
    categories.map((category) => [
      category,
      answerMetrics(outcomes.filter((o) => o.category === category)),
    ]),
  );
}

/** Mean of each metric across runs (test plan §6.5: answer metrics are averaged over runs). */
export function averageMetrics(runs: AnswerMetrics[]): AnswerMetrics {
  const keys = Object.keys(answerMetrics([])) as (keyof AnswerMetrics)[];
  return Object.fromEntries(
    keys.map((key) => {
      const values = runs.flatMap((run) => (run[key] === null ? [] : [run[key]]));
      return [
        key,
        values.length === 0 ? null : round(values.reduce((a, b) => a + b, 0) / values.length),
      ];
    }),
  ) as unknown as AnswerMetrics;
}

/** USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Cached input tokens are part of `inputTokens` but billed at the cached rate. */
export function usageCost(usage: TokenUsage, price: ModelPrice): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncached * price.input +
      usage.cachedInputTokens * price.cachedInput +
      usage.outputTokens * price.output) /
    1e6
  );
}
