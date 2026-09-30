import { z } from 'zod';
import { sourceTypeSchema } from './sources.js';

export const messageRoleSchema = z.enum(['USER', 'ASSISTANT']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/** Shared by messages and lessons. */
export const generationStatusSchema = z.enum(['COMPLETE', 'ERROR']);
export type GenerationStatus = z.infer<typeof generationStatusSchema>;

export const feedbackSchema = z.enum(['UP', 'DOWN']);
export type Feedback = z.infer<typeof feedbackSchema>;

/**
 * One `[n]` marker's source, copied at answer time (docs/03-database-design.md §5). A snapshot, so
 * it survives the source being reprocessed or deleted. Reused by lessons.
 */
export const citationSnapshotSchema = z.strictObject({
  marker: z.number().int().min(1),
  sourceId: z.uuid(),
  sourceTitle: z.string(),
  sourceType: sourceTypeSchema,
  snippet: z.string(),
  /** PDF. */
  pageNumber: z.number().int().min(1).nullable(),
  /** YouTube. */
  startSeconds: z.number().min(0).nullable(),
  /** Website / text. */
  headingPath: z.string().nullable(),
  charStart: z.number().int().min(0).nullable(),
  charEnd: z.number().int().min(0).nullable(),
});
export type CitationSnapshot = z.infer<typeof citationSnapshotSchema>;

export const citationSnapshotsSchema = z.array(citationSnapshotSchema);
