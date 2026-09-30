import type { Inngest } from 'inngest';
import { z } from 'zod';
import { ingestion } from '../config/index.js';
import type { IngestionService, StepResult } from '../services/ingestion.service.js';

const eventData = z.object({ sourceId: z.uuid(), userId: z.uuid() });

/**
 * Turns a `PENDING` source into `READY` or `FAILED`. Steps pass only the source ID; everything
 * else is read from and written to the database, so each step can be retried on its own.
 */
export function createProcessSourceFunction(client: Inngest, service: IngestionService) {
  return client.createFunction(
    {
      id: 'process-source',
      name: 'Process source',
      triggers: [{ event: 'source/created' }],
      retries: ingestion.retries,
      concurrency: [
        { limit: ingestion.concurrency },
        { limit: ingestion.concurrencyPerUser, key: 'event.data.userId' },
      ],
      throttle: ingestion.throttle,
      // Runs when a step still throws on its last attempt (e.g. the database was unreachable).
      onFailure: async ({ event }) => {
        const ref = eventData.safeParse(event.data.event.data);
        if (ref.success) await service.fail(ref.data);
      },
    },
    async ({ event, step, attempt }): Promise<StepResult> => {
      const ref = eventData.parse(event.data);
      // `attempt` counts the tries of the step that is about to run, starting at 0.
      const stepAttempt = { isLastAttempt: attempt >= ingestion.retries };

      const started = await step.run('mark-processing', () => service.start(ref));
      if (started.status !== 'ok') return started;

      const extracted = await step.run('extract', () => service.extract(ref, stepAttempt));
      if (extracted.status !== 'ok') return extracted;

      const chunked = await step.run('chunk', () => service.chunk(ref, stepAttempt));
      if (chunked.status !== 'ok') return chunked;

      return step.run('embed-and-commit', () => service.embedAndCommit(ref, stepAttempt));
    },
  );
}
