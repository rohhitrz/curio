import { z } from 'zod';

/** `POST /notebooks/:notebookId/uploads`. Size and type limits are checked by the API (own error codes). */
export const createUploadSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  fileSize: z.number().int().positive(),
  contentType: z.string().trim().min(1).max(255),
});
export type CreateUploadInput = z.infer<typeof createUploadSchema>;

export const uploadResponseSchema = z.object({
  /** Signed PUT URL; send the file with the same `Content-Type` and size. */
  uploadUrl: z.url(),
  storageKey: z.string(),
  expiresAt: z.iso.datetime(),
});
export type UploadResponse = z.infer<typeof uploadResponseSchema>;
