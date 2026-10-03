import { z } from 'zod';
import { topicRefSchema } from './notebooks.js';
import { cleanString } from './text.js';

/** Longest memory text, from extraction or the user's own edit. */
export const MEMORY_CONTENT_MAX = 300;

export const levelSchema = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']);
export type Level = z.infer<typeof levelSchema>;

export const memoryScopeSchema = z.enum(['GLOBAL', 'TOPIC']);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryKindSchema = z.enum(['LEVEL', 'STYLE', 'GOAL', 'UNDERSTOOD', 'FACT']);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memoryOriginSchema = z.enum([
  'LEVEL_CONFIRMED',
  'LESSON_COMPLETED',
  'CHAT_EXTRACTED',
  'USER_EDITED',
]);
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;

export const memorySchema = z.object({
  id: z.uuid(),
  scope: memoryScopeSchema,
  topic: topicRefSchema.nullable(),
  kind: memoryKindSchema,
  content: z.string(),
  level: levelSchema.nullable(),
  origin: memoryOriginSchema,
  /** Built by the server, e.g. "Learned from a chat". */
  originLabel: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Memory = z.infer<typeof memorySchema>;

/** `GET /memories`: not paginated (at most 200 per user). */
export const memoryListSchema = z.object({ items: z.array(memorySchema) });
export type MemoryList = z.infer<typeof memoryListSchema>;

export const memoryListQuerySchema = z.strictObject({
  scope: memoryScopeSchema.optional(),
  topicId: z.uuid().optional(),
  /** Only memories created after this instant (the "Noted" notice). */
  since: z.iso.datetime({ offset: true }).optional(),
});
export type MemoryListQuery = z.infer<typeof memoryListQuerySchema>;

/** `PATCH /memories/:memoryId`. `level` only on a `LEVEL` memory (checked by the server). */
export const updateMemorySchema = z
  .strictObject({
    content: cleanString
      .pipe(
        z
          .string()
          .trim()
          .min(1, 'Memory text is required')
          .max(MEMORY_CONTENT_MAX, `Memory text must be at most ${MEMORY_CONTENT_MAX} characters`),
      )
      .optional(),
    level: levelSchema.optional(),
  })
  .refine((body) => body.content !== undefined || body.level !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;
