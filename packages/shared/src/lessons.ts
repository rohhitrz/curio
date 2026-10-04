import { z } from 'zod';
import { citationSnapshotsSchema, generationStatusSchema } from './chat.js';

/**
 * `GET /modules/:moduleId/lesson` (latest complete version) and `GET /lessons/:lessonId`.
 * `POST /modules/:moduleId/lessons` streams one in the chat stream format.
 */
export const lessonSchema = z.object({
  id: z.uuid(),
  moduleId: z.uuid(),
  version: z.number().int().positive(),
  status: generationStatusSchema,
  model: z.string(),
  /** Markdown with `[n]` markers. */
  content: z.string(),
  citations: citationSnapshotsSchema,
  /** The module's latest tutor conversation, linked to any version of its lesson; null if none. */
  conversationId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type Lesson = z.infer<typeof lessonSchema>;

/** `PUT /modules/:moduleId/completion`. */
export const moduleCompletionSchema = z.strictObject({ completed: z.boolean() });
export type ModuleCompletionInput = z.infer<typeof moduleCompletionSchema>;
