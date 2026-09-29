import { z } from 'zod';

export const SOURCE_TITLE_MAX = 200;

export const sourceTypeSchema = z.enum(['PDF', 'WEBSITE', 'YOUTUBE', 'TEXT']);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const sourceOriginSchema = z.enum(['USER', 'LEARNING_PATH']);
export type SourceOrigin = z.infer<typeof sourceOriginSchema>;

export const sourceStatusSchema = z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']);
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(SOURCE_TITLE_MAX, `Title must be at most ${SOURCE_TITLE_MAX} characters`);

const urlSchema = z
  .string()
  .trim()
  .pipe(z.url({ protocol: /^https?$/, message: 'Must be a valid http(s) URL' }));

/**
 * `POST /notebooks/:notebookId/sources`, discriminated by `type` (docs/04-api-design.md §4).
 * Text length and YouTube validity are checked by the API (own error codes / messages).
 */
export const createSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('WEBSITE'), url: urlSchema }),
  z.strictObject({ type: z.literal('YOUTUBE'), url: urlSchema }),
  z.strictObject({
    type: z.literal('TEXT'),
    title: titleSchema,
    content: z.string().trim().min(1, 'Content is required'),
  }),
  z.strictObject({
    type: z.literal('PDF'),
    title: titleSchema,
    storageKey: z.string().min(1),
    /** SHA-256 of the file, hex, computed in the browser. */
    contentHash: z
      .string()
      .toLowerCase()
      .regex(/^[0-9a-f]{64}$/, 'Must be a SHA-256 hex digest'),
  }),
]);
export type CreateSourceInput = z.infer<typeof createSourceSchema>;

/** A source as returned by the API. Never includes extracted text. */
export const sourceSchema = z.object({
  id: z.uuid(),
  notebookId: z.uuid(),
  type: sourceTypeSchema,
  origin: sourceOriginSchema,
  title: z.string(),
  status: sourceStatusSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  url: z.string().nullable(),
  chunkCount: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  processedAt: z.iso.datetime().nullable(),
});
export type Source = z.infer<typeof sourceSchema>;

/** `PATCH /sources/:sourceId`. Only the title is editable. */
export const updateSourceSchema = z.strictObject({ title: titleSchema });
export type UpdateSourceInput = z.infer<typeof updateSourceSchema>;

/** `GET /notebooks/:notebookId/sources`. Bounded (≤ 50), so never paginated: `nextCursor` is always null. */
export const sourceListSchema = z.object({
  items: z.array(sourceSchema),
  nextCursor: z.null(),
});
export type SourceList = z.infer<typeof sourceListSchema>;

/** `GET /sources/:sourceId/file-url`. Short-lived signed GET URL for the PDF viewer. */
export const fileUrlResponseSchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime(),
});
export type FileUrlResponse = z.infer<typeof fileUrlResponseSchema>;
