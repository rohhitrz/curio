/**
 * Why a source failed, stored in `sources.error_code`. `TIMEOUT` is set by the stuck-job sweeper,
 * the rest by extraction.
 */
export const SourceErrorCode = {
  /** Nothing readable: a scanned PDF, an empty page, empty text. */
  NO_TEXT: 'NO_TEXT',
  /** The file is not a PDF, is corrupted, or is password-protected. */
  INVALID_FILE: 'INVALID_FILE',
  /** The uploaded file is no longer in storage. */
  FILE_MISSING: 'FILE_MISSING',
  PAGE_NOT_FOUND: 'PAGE_NOT_FOUND',
  /** The site refuses automated access or needs a login. */
  PAGE_BLOCKED: 'PAGE_BLOCKED',
  NO_TRANSCRIPT: 'NO_TRANSCRIPT',
  VIDEO_UNAVAILABLE: 'VIDEO_UNAVAILABLE',
  VIDEO_TOO_LONG: 'VIDEO_TOO_LONG',
  /** An outside service was unreachable, overloaded or too slow. Retried before it is final. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** Anything else, including our own misconfiguration (bad API key, no credits). */
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  TIMEOUT: 'TIMEOUT',
} as const;

export type SourceErrorCode = (typeof SourceErrorCode)[keyof typeof SourceErrorCode];

/**
 * A failed extraction. `retryable` tells the job whether to try again (transient) or fail the
 * source right away (permanent). `message` is written for the user and shown on the source.
 */
export class ExtractionError extends Error {
  readonly code: SourceErrorCode;
  readonly retryable: boolean;

  private constructor(
    code: SourceErrorCode,
    retryable: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExtractionError';
    this.code = code;
    this.retryable = retryable;
  }

  /** Retrying won't help: fail the source now with this reason. */
  static permanent(code: SourceErrorCode, message: string, options?: ErrorOptions) {
    return new ExtractionError(code, false, message, options);
  }

  /** Worth retrying: a network blip, a rate limit, a slow or overloaded service. */
  static transient(message: string, options?: ErrorOptions) {
    return new ExtractionError(SourceErrorCode.SERVICE_UNAVAILABLE, true, message, options);
  }
}
