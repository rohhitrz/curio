import type { Inngest } from 'inngest';
import { z } from 'zod';
import { conversation } from '../config/index.js';
import type { ConversationSummaryService } from '../services/conversation-summary.service.js';

const eventData = z.object({ conversationId: z.uuid(), userId: z.uuid() });

/**
 * Step output comes back as JSON from Inngest; parsing keeps the types honest (see
 * process-source).
 */
const stepResult = z.union([
  z.object({
    status: z.literal('drafted'),
    summary: z.string().nullable(),
    throughSeq: z.number().int(),
    expectedThroughSeq: z.number().int(),
  }),
  z.object({ status: z.literal('saved'), throughSeq: z.number().int() }),
  z.object({
    status: z.literal('stopped'),
    reason: z.enum(['not_found', 'up_to_date', 'superseded']),
  }),
]);

/** Folds older messages into the conversation's rolling summary (optimistic save). */
export function createSummarizeConversationFunction(
  client: Inngest,
  service: ConversationSummaryService,
) {
  return client.createFunction(
    {
      id: 'summarize-conversation',
      name: 'Summarize conversation',
      triggers: [{ event: 'conversation/summarize' }],
      retries: conversation.summaryJobRetries,
    },
    async ({ event, step }) => {
      const ref = eventData.parse(event.data);
      const draft = stepResult.parse(await step.run('draft', () => service.draft(ref)));
      if (draft.status !== 'drafted') return draft;
      // Rebuilt field by field: Vercel's non-strict build reads the parsed `summary` as optional.
      const saved = await step.run('save', () =>
        service.save(ref, {
          status: 'drafted',
          summary: draft.summary ?? null,
          throughSeq: draft.throughSeq,
          expectedThroughSeq: draft.expectedThroughSeq,
        }),
      );
      return stepResult.parse(saved);
    },
  );
}
