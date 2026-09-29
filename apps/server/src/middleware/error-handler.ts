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

const bodyErrorMessages: Record<string, string> = {
  'entity.parse.failed': 'Request body is not valid JSON.',
  'entity.too.large': 'Request body is too large.',
  'charset.unsupported': 'Request body charset is not supported.',
  'encoding.unsupported': 'Request body encoding is not supported.',
};

/**
 * body-parser rejects bad bodies (malformed, too large, bad charset/encoding, aborted) with an
 * exposed 4xx error carrying a `type`. Those are the client's fault, so they get a 400, not a 500.
 */
function bodyParserErrorMessage(err: unknown): string | undefined {
  const e = err as { type?: unknown; status?: unknown; expose?: unknown };
  if (typeof e.type !== 'string' || e.expose !== true) return undefined;
  if (typeof e.status !== 'number' || e.status < 400 || e.status >= 500) return undefined;
  return bodyErrorMessages[e.type] ?? 'Request body could not be read.';
}

/** Turns any thrown error into the standard error body. Never leaks stack traces. */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  let status: number;
  let body: ErrorResponse;
  const bodyErrorMessage = bodyParserErrorMessage(err);

  if (err instanceof AppError) {
    // Expected errors are the client's; 5xx ones (e.g. a provider outage) are ours to see.
    if (err.status >= 500) req.log.error({ err }, 'service error');
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
  } else if (bodyErrorMessage !== undefined) {
    status = 400;
    body = { error: { code: 'VALIDATION_ERROR', message: bodyErrorMessage } };
  } else {
    req.log.error({ err }, 'unhandled error');
    status = 500;
    body = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } };
  }

  res.status(status).json(body);
};
