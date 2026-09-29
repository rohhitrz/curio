import { z } from 'zod';

/** Error codes from docs/04-api-design.md §9. */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  UPLOAD_NOT_FOUND: 'UPLOAD_NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  LESSON_NOT_GENERATED: 'LESSON_NOT_GENERATED',
  DUPLICATE_SOURCE: 'DUPLICATE_SOURCE',
  ALREADY_PROCESSING: 'ALREADY_PROCESSING',
  CONVERSATION_BUSY: 'CONVERSATION_BUSY',
  LESSON_GENERATING: 'LESSON_GENERATING',
  MODULE_DISABLED: 'MODULE_DISABLED',
  PATH_NOT_READY: 'PATH_NOT_READY',
  INVALID_STATE: 'INVALID_STATE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** HTTP status for each error code. */
export const errorCodeStatus = {
  VALIDATION_ERROR: 400,
  QUOTA_EXCEEDED: 400,
  FILE_TOO_LARGE: 400,
  UNSUPPORTED_FILE_TYPE: 400,
  UPLOAD_NOT_FOUND: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  LESSON_NOT_GENERATED: 404,
  DUPLICATE_SOURCE: 409,
  ALREADY_PROCESSING: 409,
  CONVERSATION_BUSY: 409,
  LESSON_GENERATING: 409,
  MODULE_DISABLED: 409,
  PATH_NOT_READY: 409,
  INVALID_STATE: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const satisfies Record<ErrorCode, number>;

export const errorCodeSchema = z.enum(ErrorCode);

/**
 * Standard error body: `{ error: { code, message, details? } }`. `details` only for validation
 * errors, plus `DUPLICATE_SOURCE`, which carries `details.existingSourceId`.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.string()).optional(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
