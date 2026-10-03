import type { Logger } from 'pino';
import { memoryExtraction, quotas } from '../config/index.js';
import type { LlmProvider } from '../lib/llm/index.js';
import type { Tracer } from '../lib/tracing/index.js';
import {
  EXTRACTED_KINDS,
  extractMemories,
  screenOperations,
  type ExistingMemory,
  type ExtractedKind,
  type ScreenedOperation,
} from '../pipelines/memory/extract.js';
import type { ChatRepository } from '../repositories/chat.repository.js';
import type { MemoriesRepository } from '../repositories/memories.repository.js';
import type { NotebooksRepository } from '../repositories/notebooks.repository.js';

export interface ExtractionRef {
  conversationId: string;
  userId: string;
}

/** Screened operations for the messages up to `throughSeq`, not applied yet. */
export interface ExtractionDraft {
  status: 'drafted';
  operations: ScreenedOperation[];
  /** The notebook's topic, for `TOPIC` adds. */
  topicId: string | null;
  throughSeq: number;
  expectedThroughSeq: number;
}

export type ExtractionStepResult =
  | ExtractionDraft
  | { status: 'applied'; added: number; updated: number; throughSeq: number }
  | { status: 'stopped'; reason: 'not_found' | 'up_to_date' | 'superseded' };

export interface MemoryExtractionServiceDeps {
  chat: ChatRepository;
  memories: MemoriesRepository;
  notebooks: NotebooksRepository;
  llm: LlmProvider;
  tracer: Tracer;
  logger: Logger;
}

/** More than `afterMessages` messages not yet scanned → time to extract. */
export function needsExtraction(lastSeq: number, extractedThroughSeq: number): boolean {
  return lastSeq - extractedThroughSeq > memoryExtraction.afterMessages;
}

const isExtractedKind = (kind: string): kind is ExtractedKind =>
  (EXTRACTED_KINDS as readonly string[]).includes(kind);

/**
 * Chat memory extraction (docs/02-system-design.md §10): Luna reads the messages since the
 * conversation's marker with the learner's current memories and proposes adds and updates; a
 * deterministic screen drops anything that isn't a fact about the learner. Messages before the
 * marker are never read again, so a deleted memory isn't re-learned from old messages.
 */
export function createMemoryExtractionService(deps: MemoryExtractionServiceDeps) {
  const { chat, memories, notebooks, tracer, logger } = deps;

  return {
    async draft(ref: ExtractionRef): Promise<ExtractionStepResult> {
      const conversation = await chat.findConversation(ref.userId, ref.conversationId);
      if (!conversation) return { status: 'stopped', reason: 'not_found' };
      const notebook = await notebooks.findById(ref.userId, conversation.notebookId);
      if (!notebook) return { status: 'stopped', reason: 'not_found' };

      const lastSeq = (await chat.lastMessage(conversation.id))?.seq ?? 0;
      const expectedThroughSeq = conversation.memoryExtractedThroughSeq;
      // Also drops duplicate events: once one run has applied, the next finds nothing to do.
      if (!needsExtraction(lastSeq, expectedThroughSeq)) {
        return { status: 'stopped', reason: 'up_to_date' };
      }

      const topicId = notebook.topicId;
      const rows = await chat.completeMessagesBetween(conversation.id, expectedThroughSeq, lastSeq);
      const existing: ExistingMemory[] = (await memories.list(ref.userId)).flatMap((m) =>
        isExtractedKind(m.kind) && (m.scope === 'GLOBAL' || m.topicId === topicId)
          ? [
              {
                id: m.id,
                scope: m.scope,
                kind: m.kind,
                content: m.content,
                userEdited: m.origin === 'USER_EDITED',
              },
            ]
          : [],
      );

      // Facts come from the learner's own words; without any there is nothing to read.
      const operations = rows.some((row) => row.role === 'USER')
        ? await tracer
            .trace(
              {
                name: 'memory-extraction',
                userId: ref.userId,
                sessionId: conversation.id,
                metadata: { conversationId: conversation.id, throughSeq: String(lastSeq) },
              },
              () =>
                extractMemories(
                  {
                    topicName: notebook.topicName,
                    existing,
                    messages: rows.map((row) => ({
                      role: row.role === 'USER' ? 'user' : 'assistant',
                      content: row.content,
                    })),
                  },
                  { llm: deps.llm },
                ),
            )
            .finally(() =>
              tracer.flush().catch((err: unknown) => {
                logger.warn({ err }, 'trace flush failed');
              }),
            )
        : [];

      const { accepted, rejected } = screenOperations(operations, {
        existing,
        answers: rows.filter((row) => row.role === 'ASSISTANT').map((row) => row.content),
        hasTopic: topicId !== null,
      });
      if (rejected.length > 0) {
        // Reasons only: the content is about the learner.
        logger.info(
          { conversationId: conversation.id, reasons: rejected.map((r) => r.reason) },
          'memory operations dropped',
        );
      }
      return {
        status: 'drafted',
        operations: accepted,
        topicId,
        throughSeq: lastSeq,
        expectedThroughSeq,
      };
    },

    /**
     * Writes the operations, then moves the marker. Re-running after a partial failure is safe:
     * an add whose text the user already has is skipped, and updates are idempotent.
     */
    async apply(ref: ExtractionRef, draft: ExtractionDraft): Promise<ExtractionStepResult> {
      const conversation = await chat.findConversation(ref.userId, ref.conversationId);
      if (!conversation) return { status: 'stopped', reason: 'not_found' };
      if (conversation.memoryExtractedThroughSeq !== draft.expectedThroughSeq) {
        return { status: 'stopped', reason: 'superseded' };
      }

      const have = new Set((await memories.list(ref.userId)).map((m) => m.content.toLowerCase()));
      let added = 0;
      let updated = 0;
      let capped = false;
      for (const op of draft.operations) {
        if (op.action === 'update') {
          // Never a user-edited memory (M-04), even if the user edited it since the draft.
          const row = await memories.update(
            ref.userId,
            op.memoryId,
            { content: op.content },
            { unlessUserEdited: true },
          );
          if (row) updated += 1;
          continue;
        }
        if (capped || have.has(op.content.toLowerCase())) continue;
        const row = await memories.insertWithinCap(
          ref.userId,
          {
            topicId: op.scope === 'TOPIC' ? draft.topicId : null,
            kind: op.kind,
            content: op.content,
            origin: 'CHAT_EXTRACTED',
            originRef: conversation.id,
          },
          quotas.memoriesPerUser,
        );
        if (row) added += 1;
        else capped = true;
      }
      if (capped) logger.info({ userId: ref.userId }, 'memory cap reached; new memories skipped');

      const advanced = await chat.advanceMemoryMarker({
        userId: ref.userId,
        conversationId: conversation.id,
        throughSeq: draft.throughSeq,
        expectedThroughSeq: draft.expectedThroughSeq,
      });
      if (!advanced) return { status: 'stopped', reason: 'superseded' };
      return { status: 'applied', added, updated, throughSeq: draft.throughSeq };
    },
  };
}

export type MemoryExtractionService = ReturnType<typeof createMemoryExtractionService>;
