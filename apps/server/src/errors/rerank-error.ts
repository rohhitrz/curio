/**
 * A failed rerank call. Chat never fails on it: the pipeline falls back to the fused order
 * (docs/02-system-design.md §7, graceful degradation). `retryable` is for the eval runner.
 */
export class RerankError extends Error {
  readonly retryable: boolean;

  constructor(retryable: boolean, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RerankError';
    this.retryable = retryable;
  }
}
