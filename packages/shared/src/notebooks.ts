import { z } from 'zod';

export const NOTEBOOK_TITLE_MAX = 200;

export const notebookKindSchema = z.enum(['SOURCE', 'LEARNING']);
export type NotebookKind = z.infer<typeof notebookKindSchema>;

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(NOTEBOOK_TITLE_MAX, `Title must be at most ${NOTEBOOK_TITLE_MAX} characters`);

/** `POST /notebooks`. Only `SOURCE` notebooks; learning notebooks come from `POST /learning-paths`. */
export const createNotebookSchema = z.strictObject({ title: titleSchema });
export type CreateNotebookInput = z.infer<typeof createNotebookSchema>;

/** `PATCH /notebooks/:notebookId`. (`topic` arrives in Phase 7.) */
export const updateNotebookSchema = z
  .strictObject({ title: titleSchema.optional() })
  .refine((body) => body.title !== undefined, { message: 'Nothing to update' });
export type UpdateNotebookInput = z.infer<typeof updateNotebookSchema>;

export const notebookSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  kind: notebookKindSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Notebook = z.infer<typeof notebookSchema>;

/** `GET /notebooks/:notebookId`. */
export const notebookDetailSchema = notebookSchema.extend({
  sourceCount: z.number().int().nonnegative(),
  conversationCount: z.number().int().nonnegative(),
  learningPathId: z.uuid().nullable(),
});
export type NotebookDetail = z.infer<typeof notebookDetailSchema>;
