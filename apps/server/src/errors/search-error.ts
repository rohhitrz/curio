/** A failed web search. `retryable`: the job step may run it again (timeouts, 429, 5xx). */
export class SearchError extends Error {
  readonly retryable: boolean;

  constructor(retryable: boolean, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SearchError';
    this.retryable = retryable;
  }
}
