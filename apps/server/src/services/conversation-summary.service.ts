import type { Logger } from 'pino';
import { conversation as conversationLimits } from '../config/index.js';
import type { LlmProvider } from '../lib/llm/index.js';
import type { Tracer } from '../lib/tracing/index.js';
import { summarizeConversation } from '../pipelines/memory/summarize.js';
import type { ChatRepository } from '../repositories/chat.repository.js';

export interface SummaryRef {
  conversationId: string;
  userId: string;
}

/** A new summary, not saved yet. `expectedThroughSeq` is what it was drafted from. */
export interface SummaryDraft {
  status: 'drafted';
  summary: string | null;
  throughSeq: number;
  expectedThroughSeq: number;
}

export type SummaryStepResult =
  | SummaryDraft
  | { status: 'saved'; throughSeq: number }
  | { status: 'stopped'; reason: 'not_found' | 'up_to_date' | 'superseded' };

export interface ConversationSummaryServiceDeps {
  repository: ChatRepository;
  llm: LlmProvider;
  tracer: Tracer;
  logger: Logger;
}

/** More than `summarizeAfterMessages` messages after the summary → time to summarize. */
export function needsSummary(lastSeq: number, summarizedThroughSeq: number): boolean {
  return lastSeq - summarizedThroughSeq > conversationLimits.summarizeAfterMessages;
}

/**
 * The rolling summary (docs/02-system-design.md §10): everything but the last `recentMessages`
 * (sent word for word with each question) is folded into one summary. Drafting and saving are
 * separate job steps, so a failed save doesn't repeat the model call.
 */
export function createConversationSummaryService(deps: ConversationSummaryServiceDeps) {
  const { repository, tracer, logger } = deps;

  return {
    async draft(ref: SummaryRef): Promise<SummaryStepResult> {
      const conversation = await repository.findConversation(ref.userId, ref.conversationId);
      if (!conversation) return { status: 'stopped', reason: 'not_found' };

      const last = await repository.lastMessage(conversation.id);
      const lastSeq = last?.seq ?? 0;
      // Also drops duplicate events: once one run has saved, the next finds nothing to do.
      if (!needsSummary(lastSeq, conversation.summarizedThroughSeq)) {
        return { status: 'stopped', reason: 'up_to_date' };
      }

      const throughSeq = lastSeq - conversationLimits.recentMessages;
      const rows = await repository.completeMessagesBetween(
        conversation.id,
        conversation.summarizedThroughSeq,
        throughSeq,
      );
      // Only failed answers in the range: nothing to add, but the marker still moves on.
      const summary =
        rows.length === 0
          ? conversation.summary
          : await tracer
              .trace(
                {
                  name: 'conversation-summary',
                  userId: ref.userId,
                  sessionId: conversation.id,
                  metadata: { conversationId: conversation.id, throughSeq: String(throughSeq) },
                },
                () =>
                  summarizeConversation(
                    {
                      previousSummary: conversation.summary,
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
              );
      if (summary === '') throw new Error('the summary came back empty');

      return {
        status: 'drafted',
        summary,
        throughSeq,
        expectedThroughSeq: conversation.summarizedThroughSeq,
      };
    },

    async save(ref: SummaryRef, draft: SummaryDraft): Promise<SummaryStepResult> {
      const saved = await repository.saveSummary({
        userId: ref.userId,
        conversationId: ref.conversationId,
        summary: draft.summary,
        throughSeq: draft.throughSeq,
        expectedThroughSeq: draft.expectedThroughSeq,
      });
      if (!saved) {
        // Another run saved first (or the conversation is gone): its summary stands.
        logger.info({ conversationId: ref.conversationId }, 'summary superseded; not saved');
        return { status: 'stopped', reason: 'superseded' };
      }
      return { status: 'saved', throughSeq: draft.throughSeq };
    },
  };
}

export type ConversationSummaryService = ReturnType<typeof createConversationSummaryService>;
