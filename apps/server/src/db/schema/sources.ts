import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { notebooks } from './notebooks.js';
import { users } from './users.js';

export const sourceType = pgEnum('source_type', ['PDF', 'WEBSITE', 'YOUTUBE', 'TEXT']);
export const sourceOrigin = pgEnum('source_origin', ['USER', 'LEARNING_PATH']);
export const sourceStatus = pgEnum('source_status', ['PENDING', 'PROCESSING', 'READY', 'FAILED']);

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    notebookId: uuid('notebook_id')
      .notNull()
      .references(() => notebooks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: sourceType('type').notNull(),
    origin: sourceOrigin('origin').notNull().default('USER'),
    title: text('title').notNull(),
    status: sourceStatus('status').notNull().default('PENDING'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    url: text('url'),
    /** R2 key, PDF only. */
    storageKey: text('storage_key'),
    /** File hash (PDF) · normalized URL hash (website/YouTube) · content hash (text). */
    contentHash: text('content_hash').notNull(),
    extractedText: text('extracted_text'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    chunkCount: integer('chunk_count').notNull().default(0),
    embeddingModel: text('embedding_model'),
    processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // DB-level dedupe; also stops double-click races.
    unique('sources_notebook_id_content_hash_unique').on(t.notebookId, t.contentHash),
    // One uploaded file backs at most one source, so deleting a source can't break another.
    // (NULLs are distinct, so non-PDF sources are unaffected.)
    unique('sources_storage_key_unique').on(t.storageKey),
    index('sources_notebook_id_created_at_idx').on(t.notebookId, t.createdAt),
    // For the sweeper (Phase 3).
    index('sources_processing_started_at_idx')
      .on(t.processingStartedAt)
      .where(sql`${t.status} = 'PROCESSING'`),
  ],
);

export type Source = typeof sources.$inferSelect;
