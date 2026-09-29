import { type ErrorCode, errorCodeStatus } from '@curio/shared';

/** Base class for expected errors. The error handler turns these into the standard error body. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, string> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, string>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.status = errorCodeStatus[code];
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(details: Record<string, string>, message = 'Some fields are invalid.') {
    super('VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super('UNAUTHORIZED', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super('NOT_FOUND', message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(
    message = 'A required service is unavailable. Please try again shortly.',
    options?: ErrorOptions,
  ) {
    super('SERVICE_UNAVAILABLE', message, undefined, options);
  }
}
