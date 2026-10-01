/**
 * A failed LLM call, after the SDK's own retries. `retryable` tells a job whether trying again
 * later can help (rate limit, outage, timeout) or not (bad key, bad request). The message is for
 * logs; services show the user their own wording.
 */
export class LlmError extends Error {
  readonly retryable: boolean;

  constructor(retryable: boolean, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmError';
    this.retryable = retryable;
  }
}
