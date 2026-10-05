import type { Score, TraceOptions, Tracer } from '../../src/lib/tracing/index.js';

/** Records traces, spans and scores instead of sending them to Langfuse. */
export function createFakeTracer() {
  const traces: (TraceOptions & { traceId: string; output?: unknown; failed?: boolean })[] = [];
  const spans: { name: string; input: unknown; output?: unknown; failed?: boolean }[] = [];
  const scores: Score[] = [];
  const deletedScores: string[] = [];
  let flushes = 0;
  let failNextScore: Error | null = null;
  let flushFails = false;

  const tracer: Tracer = {
    async trace(options, fn) {
      const record: (typeof traces)[number] = { ...options, traceId: `trace-${traces.length + 1}` };
      traces.push(record);
      try {
        return await fn({
          traceId: record.traceId,
          setOutput: (output) => {
            record.output = output;
          },
        });
      } catch (error) {
        record.failed = true;
        throw error;
      }
    },
    async span(name, input, fn, output) {
      const record: (typeof spans)[number] = { name, input };
      spans.push(record);
      try {
        const result = await fn();
        record.output = output ? output(result) : result;
        return result;
      } catch (error) {
        record.failed = true;
        throw error;
      }
    },
    score(score) {
      if (failNextScore) {
        const error = failNextScore;
        failNextScore = null;
        return Promise.reject(error);
      }
      scores.push(score);
      return Promise.resolve();
    },
    deleteScore(id) {
      deletedScores.push(id);
      return Promise.resolve();
    },
    flush() {
      flushes += 1;
      if (flushFails) return Promise.reject(new Error('fake tracer: Langfuse unreachable'));
      return Promise.resolve();
    },
  };

  return {
    tracer,
    traces,
    spans,
    scores,
    deletedScores,
    flushes: () => flushes,
    failNextScore: (error: Error) => {
      failNextScore = error;
    },
    /** Every flush rejects from now on (Langfuse unreachable). */
    failFlushes: () => {
      flushFails = true;
    },
  };
}

export type FakeTracer = ReturnType<typeof createFakeTracer>;
