import { z } from 'zod';
import { cleanString } from './text.js';

export const NOTEBOOK_TITLE_MAX = 200;
export const TOPIC_NAME_MAX = 100;

export const notebookKindSchema = z.enum(['SOURCE', 'LEARNING']);
export type NotebookKind = z.infer<typeof notebookKindSchema>;

const titleSchema = cleanString.pipe(
  z
    .string()
    .trim()
    .min(1, 'Title is required')
    .max(NOTEBOOK_TITLE_MAX, `Title must be at most ${NOTEBOOK_TITLE_MAX} characters`),
);

/** `POST /notebooks`. Only `SOURCE` notebooks; learning notebooks come from `POST /learning-paths`. */
export const createNotebookSchema = z.strictObject({ title: titleSchema });
export type CreateNotebookInput = z.infer<typeof createNotebookSchema>;

/** A topic as the user wrote it ("Machine Learning"); matched to `topics` by its normalized form. */
export const topicNameSchema = cleanString.pipe(
  z
    .string()
    .trim()
    .min(1, 'Topic is required')
    .max(TOPIC_NAME_MAX, `Topic must be at most ${TOPIC_NAME_MAX} characters`),
);

/** `PATCH /notebooks/:notebookId`. `topic: null` clears the notebook's topic. */
export const updateNotebookSchema = z
  .strictObject({ title: titleSchema.optional(), topic: topicNameSchema.nullable().optional() })
  .refine((body) => body.title !== undefined || body.topic !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateNotebookInput = z.infer<typeof updateNotebookSchema>;

export const topicRefSchema = z.object({ id: z.uuid(), name: z.string() });
export type TopicRef = z.infer<typeof topicRefSchema>;

export const notebookSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  kind: notebookKindSchema,
  topic: topicRefSchema.nullable(),
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
