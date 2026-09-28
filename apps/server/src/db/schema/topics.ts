import { index, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core';
import { embeddings } from '../../config/models.js';

/** Shared across users; each topic embedded once. Synonyms are related by similarity, never merged. */
export const topics = pgTable(
  'topics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull().unique(),
    embedding: vector('embedding', { dimensions: embeddings.dimensions }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('topics_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops'))],
);

export type Topic = typeof topics.$inferSelect;
