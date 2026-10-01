export interface TraceOptions {
  /** e.g. `chat`, `lesson`. */
  name: string;
  /** Our user ID (never Clerk's, never an email). */
  userId: string;
  /** Groups a conversation's traces in Langfuse. */
  sessionId?: string;
  input?: unknown;
  metadata?: Record<string, string>;
}

export interface ActiveTrace {
  /** Stored on the assistant message (`messages.trace_id`) for feedback scores. */
  readonly traceId: string;
  /** Sets what the trace shows as its output. */
  setOutput(output: unknown): void;
}

export interface Score {
  traceId: string;
  name: string;
  value: number;
  /** Same ID → the score is replaced, not added (feedback changed or sent twice). */
  id?: string;
  comment?: string;
}

/**
 * Langfuse tracing (docs/02-system-design.md §12): one trace per chat or lesson request, one span
 * per pipeline step. LLM calls made inside a trace show up in it on their own.
 */
export interface Tracer {
  /** Runs `fn` as a new trace. Spans and LLM calls inside it (also awaited later) nest under it. */
  trace<T>(options: TraceOptions, fn: (trace: ActiveTrace) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` as one pipeline step of the current trace. `output` picks what the span shows
   * (e.g. chunk IDs and scores, not the chunks). A thrown error marks the span and is rethrown.
   */
  span<T>(
    name: string,
    input: unknown,
    fn: () => Promise<T>,
    output?: (result: T) => unknown,
  ): Promise<T>;
  /** Sends a score (👍 / 👎). Resolves once it is sent. */
  score(score: Score): Promise<void>;
  /** Removes a score sent with `id` (feedback taken back). */
  deleteScore(id: string): Promise<void>;
  /** Sends everything still buffered. Call before a serverless function finishes. */
  flush(): Promise<void>;
}
