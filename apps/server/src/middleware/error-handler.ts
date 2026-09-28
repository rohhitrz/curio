import type { ErrorResponse } from '@curio/shared';
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';

function zodDetails(error: ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    details[key] ??= issue.message;
  }
  return details;
}

function isBodyParseError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    (err as SyntaxError & { type?: string }).type === 'entity.parse.failed'
  );
}

/** Turns any thrown error into the standard error body. Never leaks stack traces. */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  let status: number;
  let body: ErrorResponse;

  if (err instanceof AppError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
  } else if (err instanceof ZodError) {
    status = 400;
    body = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Some fields are invalid.',
        details: zodDetails(err),
      },
    };
  } else if (isBodyParseError(err)) {
    status = 400;
    body = { error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.' } };
  } else {
    req.log.error({ err }, 'unhandled error');
    status = 500;
    body = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } };
  }

  res.status(status).json(body);
};
