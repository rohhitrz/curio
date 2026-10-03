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

/** `POST /learning-paths`. The level is the one the learner confirmed (pre-filled or picked). */
export const startPathSchema = z.strictObject({
  topic: topicNameSchema,
  level: levelSchema,
  goal: goalSchema,
});
export type StartPathInput = z.infer<typeof startPathSchema>;

/** `POST /learning-paths` → 202. */
export const startPathResponseSchema = z.object({
  pathId: z.uuid(),
  notebookId: z.uuid(),
  status: pathStatusSchema,
});
export type StartPathResponse = z.infer<typeof startPathResponseSchema>;

/** `GET /learning-paths/:pathId`: the progress poll. */
export const learningPathSchema = z.object({
  id: z.uuid(),
  notebookId: z.uuid(),
  topic: z.string(),
  level: levelSchema,
  goal: goalSchema,
  status: pathStatusSchema,
  branchOptions: branchOptionsSchema.nullable(),
  selectedBranch: z.string().nullable(),
  hook: pathHookSchema.nullable(),
  /** Set when `FAILED`: what went wrong, for the learner. */
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type LearningPath = z.infer<typeof learningPathSchema>;

/** `POST /learning-paths/:pathId/branch`: one of the path's `branchOptions` names. */
export const selectBranchSchema = z.strictObject({
  branch: z.string().trim().min(1, 'Pick a branch'),
});
export type SelectBranchInput = z.infer<typeof selectBranchSchema>;

export const outlineConceptSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** How many of the path's resources cover it. */
  coveredBy: z.number().int().nonnegative(),
  officialCovers: z.boolean(),
});

export const outlineModuleSchema = z.object({
  id: z.uuid(),
  position: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  isEnabled: z.boolean(),
  completedAt: z.iso.datetime().nullable(),
  /** Lessons arrive in Phase 9. */
  hasLesson: z.boolean(),
  concepts: z.array(outlineConceptSchema),
});
export type OutlineModule = z.infer<typeof outlineModuleSchema>;

/** `GET /learning-paths/:pathId/outline` (`READY` only). */
export const outlineSchema = z.object({
  hook: pathHookSchema.nullable(),
  modules: z.array(outlineModuleSchema),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  resources: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      url: z.string(),
      role: resourceRoleSchema,
      type: resourceTypeSchema,
      /** Null once the source was deleted from the notebook. */
      sourceId: z.uuid().nullable(),
    }),
  ),
  progress: z.object({
    completed: z.number().int().nonnegative(),
    enabled: z.number().int().nonnegative(),
  }),
});
export type Outline = z.infer<typeof outlineSchema>;

/** `PATCH /modules/:moduleId`. */
export const updateModuleSchema = z.strictObject({ isEnabled: z.boolean() });
export type UpdateModuleInput = z.infer<typeof updateModuleSchema>;

/** `PATCH /modules/:moduleId` → the module without its concepts. */
export const moduleSchema = outlineModuleSchema.omit({ concepts: true });
export type Module = z.infer<typeof moduleSchema>;
