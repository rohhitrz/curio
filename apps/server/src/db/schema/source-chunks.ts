import { type SQL, sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { embeddings } from '../../config/models.js';
import { sources } from './sources.js';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const sourceChunks = pgTable(
  'source_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    /** Denormalized from the source, so notebook-filtered search needs no join. */
    notebookId: uuid('notebook_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    /** Shown in citations. */
    content: text('content').notNull(),
    /** "Title › Section", prepended before embedding. */
    contextHeader: text('context_header').notNull(),
    embedding: vector('embedding', { dimensions: embeddings.dimensions }).notNull(),
    /** Keyword index input, built by Postgres at insert. */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce(${sourceChunks.contextHeader}, '') || ' ' || ${sourceChunks.content})`,
    ),
    tokenCount: integer('token_count').notNull(),
    /** PDF. */
    pageNumber: integer('page_number'),
    /** YouTube. */
    startSeconds: integer('start_seconds'),
    endSeconds: integer('end_seconds'),
    /** Website / text. */
    headingPath: text('heading_path'),
    /** Offsets into the source's `extracted_text`, for highlighting. */
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('source_chunks_source_id_chunk_index_unique').on(t.sourceId, t.chunkIndex),
    index('source_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('source_chunks_search_vector_idx').using('gin', t.searchVector),
    index('source_chunks_notebook_id_idx').on(t.notebookId),
  ],
);

export type SourceChunk = typeof sourceChunks.$inferSelect;
export type NewSourceChunk = typeof sourceChunks.$inferInsert;
