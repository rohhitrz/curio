import type { BranchOption, CitationSnapshot, PathHook } from '@curio/shared';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { generationStatus } from './generation-status.js';
import { level } from './level.js';
import { notebooks } from './notebooks.js';
import { sources } from './sources.js';
import { users } from './users.js';

export const goal = pgEnum('goal', ['EXAM', 'JOB', 'CURIOSITY']);
export const pathStatus = pgEnum('path_status', [
  'GATHERING',
  'READING',
  'MAPPING',
  'AWAITING_BRANCH',
  'BUILDING',
  'READY',
  'FAILED',
]);
export const resourceRole = pgEnum('resource_role', ['OFFICIAL', 'POPULAR']);
export const resourceType = pgEnum('resource_type', ['DOCS', 'ARTICLE', 'VIDEO']);
export const conceptStatus = pgEnum('concept_status', ['INCLUDED', 'SKIPPED']);

/** One per learning notebook (docs/03-database-design.md §6). */
export const learningPaths = pgTable('learning_paths', {
  id: uuid('id').primaryKey().defaultRandom(),
  notebookId: uuid('notebook_id')
    .notNull()
    .unique()
    .references(() => notebooks.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** The user's original wording. */
  topic: text('topic').notNull(),
  level: level('level').notNull(),
  goal: goal('goal').notNull(),
  status: pathStatus('status').notNull().default('GATHERING'),
  /** Validated with `branchOptionsSchema` before writing. */
  branchOptions: jsonb('branch_options').$type<BranchOption[]>(),
  selectedBranch: text('selected_branch'),
  /** Validated with `pathHookSchema` before writing. */
  hook: jsonb('hook').$type<PathHook>(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const pathResources = pgTable(
  'path_resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pathId: uuid('path_id')
      .notNull()
      .references(() => learningPaths.id, { onDelete: 'cascade' }),
    /** The ingested source; null once the user deletes it. */
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    role: resourceRole('role').notNull(),
    resourceType: resourceType('resource_type').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    /** Set when its concepts are extracted (the progress screen names what's being mapped). */
    mappedAt: timestamp('mapped_at', { withTimezone: true }),
  },
  (t) => [index('path_resources_path_id_idx').on(t.pathId)],
);

/** Progress lives here: a path has one owner. */
export const modules = pgTable(
  'modules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pathId: uuid('path_id')
      .notNull()
      .references(() => learningPaths.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    /** Why it matters and how it builds on the last; null on paths built before Phase 9. */
    why: text('why'),
    /** Relative within the path; null on paths built before Phase 9. */
    difficulty: level('difficulty'),
    isEnabled: boolean('is_enabled').notNull().default(true),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [unique('modules_path_id_position_unique').on(t.pathId, t.position)],
);

export const concepts = pgTable(
  'concepts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pathId: uuid('path_id')
      .notNull()
      .references(() => learningPaths.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    consensusScore: numeric('consensus_score', { mode: 'number' }).notNull(),
    status: conceptStatus('status').notNull(),
    skipReason: text('skip_reason'),
    moduleId: uuid('module_id').references(() => modules.id, { onDelete: 'set null' }),
    position: integer('position'),
  },
  (t) => [
    index('concepts_path_id_idx').on(t.pathId),
    index('concepts_module_id_position_idx').on(t.moduleId, t.position),
  ],
);

/** Which resources cover which concept: the evidence behind every include/skip decision. */
export const conceptCoverage = pgTable(
  'concept_coverage',
  {
    conceptId: uuid('concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    pathResourceId: uuid('path_resource_id')
      .notNull()
      .references(() => pathResources.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.conceptId, t.pathResourceId] })],
);

/** Versions of a module's lesson; the latest is shown, regenerate adds one. */
export const lessons = pgTable(
  'lessons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** Markdown with `[n]` markers. */
    content: text('content').notNull(),
    /** Validated with `citationSnapshotsSchema` before writing (same shape as messages). */
    citations: jsonb('citations').$type<CitationSnapshot[]>().notNull().default([]),
    status: generationStatus('status').notNull(),
    traceId: text('trace_id'),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('lessons_module_id_version_unique').on(t.moduleId, t.version)],
);

export type LearningPath = typeof learningPaths.$inferSelect;
export type PathResource = typeof pathResources.$inferSelect;
export type Module = typeof modules.$inferSelect;
export type Concept = typeof concepts.$inferSelect;
export type Lesson = typeof lessons.$inferSelect;
