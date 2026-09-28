import { type ErrorCode, errorResponseSchema } from '@curio/shared';

/** An API failure in the standard error format (docs/04-api-design.md §1). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Builds an `ApiError` from a failed response, falling back when the body isn't the standard format. */
export function toApiError(status: number, body: unknown): ApiError {
  const parsed = errorResponseSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(status, code, message, details);
  }
  if (status === 503) {
    return new ApiError(
      status,
      'SERVICE_UNAVAILABLE',
      'The service is unavailable. Try again shortly.',
    );
  }
  return new ApiError(status, 'INTERNAL_ERROR', 'Something went wrong.');
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
