import type { Inngest } from 'inngest';
import type { Logger } from 'pino';
import { z } from 'zod';
import { learningPaths } from '../config/index.js';
import type {
  LearningPathGenerationService,
  PathErrorCode,
} from '../services/learning-path-generation.service.js';
import type { createProcessSourceFunction } from './process-source.js';

const eventData = z.object({ pathId: z.uuid(), userId: z.uuid() });

const errorCodes = [
  'SEARCH_FAILED',
  'NO_RESOURCES',
  'TOO_FEW_RESOURCES',
  'GENERATION_FAILED',
] as const satisfies readonly PathErrorCode[];

const stopped = z.union([
  z.object({ status: z.literal('stopped'), reason: z.enum(['not_found', 'not_gathering']) }),
  z.object({ status: z.literal('stopped'), reason: z.literal('failed'), code: z.enum(errorCodes) }),
]);

const purpose = z.enum(['official', 'popular', 'video']);
const candidate = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  score: z.number(),
  purpose,
  videoId: z.string().nullish(),
});
const resource = z.object({
  role: z.enum(['OFFICIAL', 'POPULAR']),
  resourceType: z.enum(['DOCS', 'ARTICLE', 'VIDEO']),
  title: z.string(),
  url: z.string(),
  videoId: z.string().nullish(),
});

/** Step output comes back as JSON from Inngest; parsing keeps the types honest (see process-source). */
const claimed = z.union([
  z.object({ status: z.literal('claimed'), hasResources: z.boolean() }),
  stopped,
]);
const searched = z.union([
  z.object({ status: z.literal('searched'), candidates: z.array(candidate) }),
  stopped,
]);
const selected = z.union([
  z.object({ status: z.literal('selected'), resources: z.array(resource) }),
  stopped,
]);
const saved = z.union([
  z.object({ status: z.literal('saved'), ingest: z.array(z.uuid()) }),
  stopped,
]);
const reading = z.union([
  z.object({ status: z.literal('read'), ready: z.number(), total: z.number() }),
  z.object({ status: z.literal('in_flight'), inFlight: z.number() }),
  stopped,
]);

/**
 * Builds a learning path (docs/02-system-design.md §8). Part 1 (8.3): claim → search → select →
 * save the resources as sources of the path's notebook → read them by invoking `processSource`
 * for each, in parallel (decision L-03: the normal ingestion pipeline) → `MAPPING`, or `FAILED`
 * when fewer than `minResources` were read.
 */
export function createGenerateLearningPathFunction(
  client: Inngest,
  service: LearningPathGenerationService,
  processSource: ReturnType<typeof createProcessSourceFunction>,
  logger: Logger,
) {
  return client.createFunction(
    {
      id: 'generate-learning-path',
      name: 'Generate learning path',
      triggers: [{ event: 'path/requested' }],
      retries: learningPaths.jobRetries,
      concurrency: [
        { limit: learningPaths.concurrency },
        { limit: learningPaths.concurrencyPerUser, key: 'event.data.userId' },
      ],
      onFailure: async ({ event }) => {
        const ref = eventData.safeParse(event.data.event.data);
        if (ref.success) await service.failUnexpectedly(ref.data);
      },
    },
    async ({ event, step, attempt }) => {
      const ref = eventData.parse(event.data);
      // `attempt` counts the tries of the step about to run, starting at 0.
      const stepAttempt = { isLastAttempt: attempt >= learningPaths.jobRetries };

      const claim = claimed.parse(await step.run('claim', () => service.claim(ref)));
      if (claim.status !== 'claimed') return claim;

      // A retried path keeps the resources it already has.
      let resources: z.infer<typeof resource>[] = [];
      if (!claim.hasResources) {
        const found = searched.parse(
          await step.run('search', () => service.search(ref, stepAttempt)),
        );
        if (found.status !== 'searched') return found;
        // Rebuilt field by field: Vercel's non-strict build reads parsed nullable fields as optional.
        const candidates = found.candidates.map((c) => ({ ...c, videoId: c.videoId ?? null }));

        const picked = selected.parse(
          await step.run('select', () => service.select(ref, candidates, stepAttempt)),
        );
        if (picked.status !== 'selected') return picked;
        resources = picked.resources;
      }

      const save = saved.parse(
        await step.run('save-resources', () =>
          service.save(
            ref,
            resources.map((r) => ({ ...r, videoId: r.videoId ?? null })),
          ),
        ),
      );
      if (save.status !== 'saved') return save;

      // A failed or timed-out ingestion run is fine here: the database says what was read.
      await Promise.all(
        save.ingest.map((sourceId) =>
          step
            .invoke(`ingest-${sourceId}`, {
              function: processSource,
              data: { sourceId, userId: ref.userId },
              timeout: learningPaths.ingestTimeout,
            })
            .catch((err: unknown) => {
              logger.warn({ err, ...ref, sourceId }, 'learning path resource not ingested');
            }),
        ),
      );

      const { every, times } = learningPaths.inFlightRecheck;
      for (let check = 0; ; check += 1) {
        const result = reading.parse(
          await step.run(`finish-reading-${String(check)}`, () =>
            service.finishReading(ref, { lastCheck: check >= times }),
          ),
        );
        if (result.status !== 'in_flight') return result;
        await step.sleep(`wait-for-reading-${String(check)}`, every);
      }
    },
  );
}
