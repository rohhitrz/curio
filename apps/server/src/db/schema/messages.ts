import type { CitationSnapshot } from '@curio/shared';
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversations } from './conversations.js';

export const messageRole = pgEnum('message_role', ['USER', 'ASSISTANT']);
/** Shared with lessons (Phase 9). */
export const generationStatus = pgEnum('generation_status', ['COMPLETE', 'ERROR']);
export const feedback = pgEnum('feedback', ['UP', 'DOWN']);

export const messages = pgTable(
  'messages',
  {
    /** User messages keep the client-generated id, so a resend is recognized as a retry. */
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: messageRole('role').notNull(),
    /** With `[n]` markers. */
    content: text('content').notNull(),
    /** Validated with `citationSnapshotsSchema` before writing. */
    citations: jsonb('citations').$type<CitationSnapshot[]>().notNull().default([]),
    status: generationStatus('status').notNull().default('COMPLETE'),
    /** Langfuse trace: retrieved chunks, scores and rewritten queries live there, not here. */
    traceId: text('trace_id'),
    feedback: feedback('feedback'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('messages_conversation_id_seq_unique').on(t.conversationId, t.seq)],
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
