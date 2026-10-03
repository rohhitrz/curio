import { z } from 'zod';
import { levelSchema } from './memories.js';
import { topicNameSchema } from './notebooks.js';

export const goalSchema = z.enum(['EXAM', 'JOB', 'CURIOSITY']);
export type Goal = z.infer<typeof goalSchema>;

/** Drives the progress screen; `AWAITING_BRANCH` = the job is paused for the branch pick. */
export const pathStatusSchema = z.enum([
  'GATHERING',
  'READING',
  'MAPPING',
  'AWAITING_BRANCH',
  'BUILDING',
  'READY',
  'FAILED',
]);
export type PathStatus = z.infer<typeof pathStatusSchema>;

export const resourceRoleSchema = z.enum(['OFFICIAL', 'POPULAR']);
export type ResourceRole = z.infer<typeof resourceRoleSchema>;

export const resourceTypeSchema = z.enum(['DOCS', 'ARTICLE', 'VIDEO']);
export type ResourceType = z.infer<typeof resourceTypeSchema>;

export const conceptStatusSchema = z.enum(['INCLUDED', 'SKIPPED']);
export type ConceptStatus = z.infer<typeof conceptStatusSchema>;

/** `learning_paths.hook`: the path's opening (what / why / example / 2-line origin). */
export const pathHookSchema = z.object({
  what: z.string(),
  why: z.string(),
  example: z.string(),
  origin: z.string(),
});
export type PathHook = z.infer<typeof pathHookSchema>;

/** One entry of `learning_paths.branch_options` (advanced paths); picked by `name`. */
export const branchOptionSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export type BranchOption = z.infer<typeof branchOptionSchema>;
export const branchOptionsSchema = z.array(branchOptionSchema);

/** `GET /learning-paths/prefill?topic=`. */
export const prefillQuerySchema = z.strictObject({ topic: topicNameSchema });
export type PrefillQuery = z.infer<typeof prefillQuerySchema>;

/**
 * A level the learner confirmed before, offered for confirmation: for this very topic (`EXACT`)
 * or a similar one (`RELATED`). `null` → a new topic: always ask.
 */
export const prefillResponseSchema = z.object({
  match: z
    .object({
      type: z.enum(['EXACT', 'RELATED']),
      topicName: z.string(),
      level: levelSchema,
    })
    .nullable(),
});
export type PrefillResponse = z.infer<typeof prefillResponseSchema>;
