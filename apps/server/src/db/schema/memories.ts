import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { concepts } from './learning-paths.js';
import { level } from './level.js';
import { topics } from './topics.js';
import { users } from './users.js';

export const memoryScope = pgEnum('memory_scope', ['GLOBAL', 'TOPIC']);
export const memoryKind = pgEnum('memory_kind', ['LEVEL', 'STYLE', 'GOAL', 'UNDERSTOOD', 'FACT']);
export const memoryOrigin = pgEnum('memory_origin', [
  'LEVEL_CONFIRMED',
  'LESSON_COMPLETED',
  'CHAT_EXTRACTED',
  'USER_EDITED',
]);

/**
 * Long-term learner memory (docs/03-database-design.md §7). Facts about the learner only, never
 * source content. Not tied to a notebook: deleting one keeps its memories.
 */
export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: memoryScope('scope').notNull(),
    topicId: uuid('topic_id').references(() => topics.id),
    kind: memoryKind('kind').notNull(),
    content: text('content').notNull(),
    level: level('level'),
    /** The concept an `UNDERSTOOD` memory is about; the text is kept if the concept goes. */
    conceptId: uuid('concept_id').references(() => concepts.id, { onDelete: 'set null' }),
    origin: memoryOrigin('origin').notNull(),
    /** What wrote it, e.g. the module for `LESSON_COMPLETED` (un-marking removes these). */
    originRef: uuid('origin_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('memories_topic_scope_check', sql`(${t.scope} = 'TOPIC') = (${t.topicId} IS NOT NULL)`),
    check(
      'memories_level_check',
      sql`${t.kind} <> 'LEVEL' OR (${t.level} IS NOT NULL AND ${t.scope} = 'TOPIC')`,
    ),
    uniqueIndex('memories_one_level_per_topic')
      .on(t.userId, t.topicId)
      .where(sql`${t.kind} = 'LEVEL'`),
    uniqueIndex('memories_one_understood_per_concept')
      .on(t.userId, t.conceptId)
      .where(sql`${t.kind} = 'UNDERSTOOD'`),
    index('memories_user_id_scope_topic_id_idx').on(t.userId, t.scope, t.topicId),
  ],
);

export type Memory = typeof memories.$inferSelect;
