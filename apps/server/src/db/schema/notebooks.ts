import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { topics } from './topics.js';
import { users } from './users.js';

export const notebookKind = pgEnum('notebook_kind', ['SOURCE', 'LEARNING']);

export const notebooks = pgTable(
  'notebooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    kind: notebookKind('kind').notNull(),
    topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('notebooks_user_id_updated_at_idx').on(t.userId, t.updatedAt.desc())],
);

export type Notebook = typeof notebooks.$inferSelect;
