import { levelSchema, pathHookSchema } from '@curio/shared';
import type { Inngest } from 'inngest';
import type { Logger } from 'pino';
import { z } from 'zod';
import { learningPaths } from '../config/index.js';
import type {
  LearningPathGenerationService,
  PathErrorCode,
} from '../services/learning-path-generation.service.js';
import type { LearningPathOutlineService } from '../services/learning-path-outline.service.js';
import type { createProcessSourceFunction } from './process-source.js';

const eventData = z.object({ pathId: z.uuid(), userId: z.uuid() });

const errorCodes = [
  'SEARCH_FAILED',
  'NO_RESOURCES',
  'TOO_FEW_RESOURCES',
  'BRANCH_NOT_PICKED',
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
  z.object({
    status: z.literal('claimed'),
    hasResources: z.boolean(),
    level: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']),
  }),
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

const role = z.enum(['OFFICIAL', 'POPULAR']);
const readResource = z.object({ resourceId: z.uuid(), role, title: z.string() });
const listed = z.union([
  z.object({ status: z.literal('listed'), resources: z.array(readResource) }),
  stopped,
]);
const concepts = z.array(z.object({ name: z.string(), description: z.string() }));
const mappedResource = readResource.extend({ concepts });
const recalled = z.union([
  z.object({ status: z.literal('recalled'), concepts }),
  z.object({ status: z.literal('unrecalled') }),
  stopped,
]);
const mapped = z.union([
  z.object({ status: z.literal('mapped'), resource: mappedResource }),
  z.object({ status: z.literal('unmapped'), resourceId: z.string() }),
  stopped,
]);
const pathConcept = z.object({
  key: z.number().int(),
  name: z.string(),
  description: z.string(),
  resourceIds: z.array(z.string()),
  score: z.number(),
  gap: z.boolean(),
  fromModel: z.boolean().optional(),
});
const merged = z.union([
  z.object({
    status: z.literal('merged'),
    concepts: z.array(pathConcept),
    resourceCount: z.number().int(),
  }),
  stopped,
]);
const outlineModule = z.object({
  title: z.string(),
  summary: z.string(),
  // Absent in step results saved before Phase 9 (a run in flight across the deploy).
  why: z.string().nullable().default(null),
  difficulty: levelSchema.nullable().default(null),
  conceptKeys: z.array(z.number().int()),
});
const outline = z.object({
  concepts: z.array(pathConcept),
  modules: z.array(outlineModule),
  branches: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      moduleIndexes: z.array(z.number().int()),
    }),
  ),
});
const ordered = z.union([z.object({ status: z.literal('ordered'), outline }), stopped]);
const offered = z.union([z.object({ status: z.enum(['offered', 'no_branches']) }), stopped]);
const branchCheck = z.union([
  z.object({ status: z.literal('chosen'), branch: z.string() }),
  z.object({ status: z.literal('waiting') }),
  stopped,
]);
const cut = z.object({
  modules: z.array(outlineModule),
  skipped: z.array(z.object({ key: z.number().int(), reason: z.string() })),
});
const built = z.union([z.object({ status: z.literal('built'), cut }), stopped]);
const hooked = z.union([
  z.object({ status: z.literal('hooked'), hook: pathHookSchema.nullable() }),
  stopped,
]);
const ready = z.union([
  z.object({
    status: z.literal('ready'),
    modules: z.number(),
    included: z.number(),
    skipped: z.number(),
  }),
  stopped,
]);

/**
 * Builds a learning path (docs/02-system-design.md §8).
 * - Part 1: claim → search → select → save the resources as sources of the path's notebook →
 *   read them by invoking `processSource` for each, in parallel (decision L-03) → `MAPPING`, or
 *   `FAILED` when fewer than `minResources` were read.
 * - Part 2: map each read resource (in parallel) → merge + consensus → order + modules → advanced:
 *   offer branches and pause for the pick (decision L-04) → `BUILDING`: cut rules → hook → save
 *   → `READY`.
 */
export function createGenerateLearningPathFunction(
  client: Inngest,
  service: LearningPathGenerationService,
  outlineService: LearningPathOutlineService,
  processSource: ReturnType<typeof createProcessSourceFunction>,
  logger: Logger,
  /** Waits; tests shorten them. */
  waits: Record<'inFlightRecheck' | 'branchWait', { every: string; times: number }> = learningPaths,
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

      const recheck = waits.inFlightRecheck;
      for (let check = 0; ; check += 1) {
        const result = reading.parse(
          await step.run(`finish-reading-${String(check)}`, () =>
            service.finishReading(ref, { lastCheck: check >= recheck.times }),
          ),
        );
        if (result.status === 'read') break;
        if (result.status !== 'in_flight') return result;
        await step.sleep(`wait-for-reading-${String(check)}`, recheck.every);
      }

      // --- Part 2: map → merge → order → (branch) → cut → hook → save.
      const read = listed.parse(await step.run('list-read', () => outlineService.listRead(ref)));
      if (read.status !== 'listed') return read;

      // The model's own concept list (L-09) is recalled alongside the maps.
      const [recall, ...maps] = await Promise.all([
        step
          .run('recall', () => outlineService.recall(ref, stepAttempt))
          .then((r) => recalled.parse(r)),
        ...read.resources.map(async (r) =>
          mapped.parse(
            await step.run(`map-${r.resourceId}`, () =>
              outlineService.mapResource(ref, r, stepAttempt),
            ),
          ),
        ),
      ]);
      if (recall.status === 'stopped') return recall;
      const stoppedMap = maps.find((m) => m.status === 'stopped');
      if (stoppedMap) return stoppedMap;
      const mappedResources = maps.flatMap((m) => (m.status === 'mapped' ? [m.resource] : []));
      const recalledConcepts = recall.status === 'recalled' ? recall.concepts : null;

      const merge = merged.parse(
        await step.run('merge', () =>
          outlineService.merge(ref, mappedResources, read.resources.length, recalledConcepts),
        ),
      );
      if (merge.status !== 'merged') return merge;

      const order = ordered.parse(
        await step.run('order', () =>
          outlineService.order(ref, merge.concepts, merge.resourceCount),
        ),
      );
      if (order.status !== 'ordered') return order;

      let branch: string | null = null;
      if (claim.level === 'ADVANCED') {
        const offer = offered.parse(
          await step.run('offer-branches', () => outlineService.offerBranches(ref, order.outline)),
        );
        if (offer.status === 'stopped') return offer;
        if (offer.status === 'offered') {
          const wait = waits.branchWait;
          for (let slice = 0; branch === null; slice += 1) {
            // The pick is read from the database after each wait: the event only wakes the job.
            await step.waitForEvent(`wait-for-branch-${String(slice)}`, {
              event: 'path/branch-selected',
              timeout: wait.every,
              match: 'data.pathId',
            });
            const check = branchCheck.parse(
              await step.run(`check-branch-${String(slice)}`, () =>
                outlineService.chosenBranch(ref, order.outline),
              ),
            );
            if (check.status === 'stopped') return check;
            if (check.status === 'chosen') branch = check.branch;
            else if (slice + 1 >= wait.times) {
              return stopped.parse(
                await step.run('branch-not-picked', () => outlineService.failBranchNotPicked(ref)),
              );
            }
          }
        }
      }

      const build = built.parse(
        await step.run('build', () =>
          outlineService.build(ref, order.outline, branch, merge.resourceCount),
        ),
      );
      if (build.status !== 'built') return build;

      const hook = hooked.parse(
        await step.run('hook', () => outlineService.hook(ref, build.cut, stepAttempt)),
      );
      if (hook.status !== 'hooked') return hook;

      return ready.parse(
        await step.run('save', () =>
          outlineService.save(ref, order.outline, build.cut, hook.hook ?? null),
        ),
      );
    },
  );
}
