import type { Inngest } from 'inngest';
import { z } from 'zod';
import { memoryExtraction } from '../config/index.js';
import { EXTRACTED_KINDS } from '../pipelines/memory/extract.js';
import type { MemoryExtractionService } from '../services/memory-extraction.service.js';

const eventData = z.object({ conversationId: z.uuid(), userId: z.uuid() });

const operation = z.union([
  z.object({
    action: z.literal('add'),
    kind: z.enum(EXTRACTED_KINDS),
    scope: z.enum(['GLOBAL', 'TOPIC']),
    content: z.string(),
  }),
  z.object({ action: z.literal('update'), memoryId: z.string(), content: z.string() }),
]);

/** Step output comes back as JSON from Inngest; parsing keeps the types honest (see process-source). */
const stepResult = z.union([
  z.object({
    status: z.literal('drafted'),
    operations: z.array(operation),
    topicId: z.string().nullable(),
    throughSeq: z.number().int(),
    expectedThroughSeq: z.number().int(),
  }),
  z.object({
    status: z.literal('applied'),
    added: z.number().int(),
    updated: z.number().int(),
    throughSeq: z.number().int(),
  }),
  z.object({
    status: z.literal('stopped'),
    reason: z.enum(['not_found', 'up_to_date', 'superseded']),
  }),
]);

/**
 * Turns new chat messages into learner memories. One run per user at a time: runs of two
 * conversations would otherwise race on the same memories and the cap.
 */
export function createExtractMemoriesFunction(client: Inngest, service: MemoryExtractionService) {
  return client.createFunction(
    {
      id: 'extract-memories',
      name: 'Extract memories',
      triggers: [{ event: 'memory/extract' }],
      retries: memoryExtraction.jobRetries,
      concurrency: [{ limit: 1, key: 'event.data.userId' }],
    },
    async ({ event, step }) => {
      const ref = eventData.parse(event.data);
      const draft = stepResult.parse(await step.run('draft', () => service.draft(ref)));
      if (draft.status !== 'drafted') return draft;
      // Rebuilt field by field: Vercel's non-strict build reads parsed nullable fields as optional.
      const applied = await step.run('apply', () =>
        service.apply(ref, {
          status: 'drafted',
          operations: draft.operations,
          topicId: draft.topicId ?? null,
          throughSeq: draft.throughSeq,
          expectedThroughSeq: draft.expectedThroughSeq,
        }),
      );
      return stepResult.parse(applied);
    },
  );
}
