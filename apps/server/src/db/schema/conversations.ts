import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { lessons } from './learning-paths.js';
import { notebooks } from './notebooks.js';
import { users } from './users.js';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    notebookId: uuid('notebook_id')
      .notNull()
      .references(() => notebooks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Set → the module's tutor: chat is limited to the sources that lesson version cites. */
    lessonId: uuid('lesson_id').references(() => lessons.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    summary: text('summary'),
    summarizedThroughSeq: integer('summarized_through_seq').notNull().default(0),
    memoryExtractedThroughSeq: integer('memory_extracted_through_seq').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('conversations_notebook_id_last_message_at_idx').on(t.notebookId, t.lastMessageAt.desc()),
    index('conversations_lesson_id_idx').on(t.lessonId),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
