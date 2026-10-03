import type { PathHook } from '@curio/shared';
import type { Logger } from 'pino';
import type { LlmProvider } from '../lib/llm/index.js';
import type { Tracer } from '../lib/tracing/index.js';
import { cutPath, type CutPath, type CutRules } from '../pipelines/learning/cut.js';
import { generateHook } from '../pipelines/learning/hook.js';
import { fairShare, mapResource } from '../pipelines/learning/map.js';
import {
  applyMerge,
  mergeConcepts,
  type MappedResource,
  type PathConcept,
} from '../pipelines/learning/merge.js';
import { applyOrder, orderConcepts, type Outline } from '../pipelines/learning/order.js';
import type {
  LearningPathsRepository,
  OutlineToSave,
  PathRef,
} from '../repositories/learning-paths.repository.js';
import {
  failPath,
  isRetryable,
  pathMessages,
  type PathErrorCode,
  type StepAttempt,
  type Stopped,
} from './learning-path-generation.service.js';

export type ReadResource = Omit<MappedResource, 'concepts'>;

export type ListStepResult = { status: 'listed'; resources: ReadResource[] } | Stopped;
export type MapStepResult =
  | { status: 'mapped'; resource: MappedResource }
  | { status: 'unmapped'; resourceId: string }
  | Stopped;
export type MergeStepResult =
  { status: 'merged'; concepts: PathConcept[]; resourceCount: number } | Stopped;
export type OrderStepResult = { status: 'ordered'; outline: Outline } | Stopped;
export type OfferStepResult = { status: 'offered' } | { status: 'no_branches' } | Stopped;
export type BranchCheckResult =
  { status: 'chosen'; branch: string } | { status: 'waiting' } | Stopped;
export type BuildStepResult = { status: 'built'; cut: CutPath } | Stopped;
export type HookStepResult = { status: 'hooked'; hook: PathHook | null } | Stopped;
export type SaveStepResult =
  { status: 'ready'; modules: number; included: number; skipped: number } | Stopped;

export interface LearningPathOutlineDeps {
  repository: LearningPathsRepository;
  llm: LlmProvider;
  tracer: Tracer;
  logger: Logger;
  limits: {
    minResources: number;
    mapMaxChars: number;
    maxConceptsPerResource: number;
    officialMapMaxChars: number;
    mapReadMaxChars: number;
    officialMaxConcepts: number;
    maxGapConcepts: number;
    minBranchConcepts: number;
    hookSourceChars: number;
    consensus: { officialWeight: number; popularWeight: number };
    cut: CutRules;
  };
}

const NOT_FOUND: Stopped = { status: 'stopped', reason: 'not_found' };

/** The finished outline as rows: kept concepts in their modules, skipped ones with a reason. */
export function toOutlineRows(
  outline: Outline,
  cut: CutPath,
  hook: PathHook | null,
): OutlineToSave {
  const byKey = new Map(outline.concepts.map((c) => [c.key, c]));
  const placed = cut.modules.flatMap((m, module) =>
    m.conceptKeys.map((key, i) => ({ key, module, position: i + 1 })),
  );
  const rows: OutlineToSave['concepts'] = [];
  for (const { key, module, position } of placed) {
    const c = byKey.get(key);
    if (!c) continue;
    rows.push({
      name: c.name,
      description: c.description,
      consensusScore: c.score,
      status: 'INCLUDED',
      skipReason: null,
      module,
      position,
      resourceIds: c.resourceIds,
    });
  }
  for (const { key, reason } of cut.skipped) {
    const c = byKey.get(key);
    if (!c) continue;
    rows.push({
      name: c.name,
      description: c.description,
      consensusScore: c.score,
      status: 'SKIPPED',
      skipReason: reason,
      module: null,
      position: null,
      resourceIds: c.resourceIds,
    });
  }
  return {
    modules: cut.modules.map((m) => ({ title: m.title, summary: m.summary })),
    concepts: rows,
    hook,
  };
}

/**
 * The `generateLearningPath` job's steps, part 2 (docs/02-system-design.md §8, steps 4–7): map
 * each resource → merge → consensus → order + modules → (advanced: branch pick) → cut → hook →
 * `READY`. The model does the language work; code checks its output and makes every decision.
 */
export function createLearningPathOutlineService(deps: LearningPathOutlineDeps) {
  const { repository, llm, tracer, logger, limits } = deps;
  const fail = (ref: PathRef, code: PathErrorCode, message: string) =>
    failPath({ repository, logger }, ref, code, message);

  const traced = <T>(ref: PathRef, name: string, fn: () => Promise<T>) =>
    tracer.trace({ name, userId: ref.userId, metadata: { pathId: ref.pathId } }, fn);

  return {
    async listRead(ref: PathRef): Promise<ListStepResult> {
      if (!(await repository.findForJob(ref))) return NOT_FOUND;
      return { status: 'listed', resources: await repository.readResources(ref) };
    },

    /**
     * One resource's concepts. A resource that can't be mapped (on the last attempt, or with no
     * text) is left out rather than failing the path; `merge` checks enough remain.
     */
    async mapResource(
      ref: PathRef,
      resource: ReadResource,
      { isLastAttempt }: StepAttempt,
    ): Promise<MapStepResult> {
      const path = await repository.findForJob(ref);
      if (!path) return NOT_FOUND;
      // The official docs were read as a section (L-08): a bigger budget.
      const official = resource.role === 'OFFICIAL';
      const source = await repository.resourceText(
        ref,
        resource.resourceId,
        limits.mapReadMaxChars,
      );
      if (!source?.text.trim()) return { status: 'unmapped', resourceId: resource.resourceId };

      try {
        const concepts = await traced(ref, 'learning-path-map', () =>
          mapResource(
            {
              topic: path.topic,
              level: path.level,
              title: resource.title,
              text: fairShare(
                source.text,
                official ? limits.officialMapMaxChars : limits.mapMaxChars,
              ),
              maxConcepts: official ? limits.officialMaxConcepts : limits.maxConceptsPerResource,
            },
            { llm },
          ),
        );
        if (concepts.length === 0) return { status: 'unmapped', resourceId: resource.resourceId };
        return { status: 'mapped', resource: { ...resource, concepts } };
      } catch (err) {
        if (!isLastAttempt && isRetryable(err)) throw err;
        logger.warn({ err, ...ref, resourceId: resource.resourceId }, 'resource not mapped');
        return { status: 'unmapped', resourceId: resource.resourceId };
      }
    },

    /** Same concepts across resources grouped, then scored by consensus. */
    async merge(ref: PathRef, mapped: MappedResource[], read: number): Promise<MergeStepResult> {
      const path = await repository.findForJob(ref);
      if (!path) return NOT_FOUND;
      if (mapped.length < limits.minResources) {
        return fail(
          ref,
          'TOO_FEW_RESOURCES',
          pathMessages.tooFewMapped(mapped.length, read, limits.minResources),
        );
      }
      const groups = await traced(ref, 'learning-path-merge', () =>
        mergeConcepts(path.topic, mapped, { llm }),
      );
      return {
        status: 'merged',
        concepts: applyMerge(mapped, groups, limits.consensus),
        resourceCount: mapped.length,
      };
    },

    async order(
      ref: PathRef,
      concepts: PathConcept[],
      resourceCount: number,
    ): Promise<OrderStepResult> {
      const path = await repository.findForJob(ref);
      if (!path) return NOT_FOUND;
      const output = await traced(ref, 'learning-path-order', () =>
        orderConcepts(path, concepts, resourceCount, { llm }),
      );
      // An unusable outline throws, so the step is retried.
      return { status: 'ordered', outline: applyOrder(concepts, output, limits) };
    },

    /** Advanced paths: offer the branches and pause. None usable → built like intermediate. */
    async offerBranches(ref: PathRef, outline: Outline): Promise<OfferStepResult> {
      if (outline.branches.length === 0) {
        logger.warn({ ...ref }, 'advanced path without branches; cut as intermediate');
        return { status: 'no_branches' };
      }
      const offered = await repository.offerBranches(
        ref,
        outline.branches.map((b) => ({ name: b.name, description: b.description })),
      );
      if (offered) return { status: 'offered' };
      // A repeated step finds them offered already (and must not clear a pick).
      const path = await repository.findForJob(ref);
      return path?.status === 'AWAITING_BRANCH' ? { status: 'offered' } : NOT_FOUND;
    },

    /** The pick, read from the database (the event only wakes the job). */
    async chosenBranch(ref: PathRef, outline: Outline): Promise<BranchCheckResult> {
      const path = await repository.findForJob(ref);
      // Past AWAITING_BRANCH only when this step is repeated after the build started.
      if (!path || !['AWAITING_BRANCH', 'BUILDING', 'READY'].includes(path.status)) {
        return NOT_FOUND;
      }
      const branch = path.selectedBranch;
      if (branch && outline.branches.some((b) => b.name === branch)) {
        return { status: 'chosen', branch };
      }
      return { status: 'waiting' };
    },

    failBranchNotPicked(ref: PathRef): Promise<Stopped> {
      return fail(ref, 'BRANCH_NOT_PICKED', pathMessages.branchNotPicked);
    },

    /** `BUILDING`, and the cut rules applied (pure). */
    async build(
      ref: PathRef,
      outline: Outline,
      branch: string | null,
      resourceCount: number,
    ): Promise<BuildStepResult> {
      const path = await repository.findForJob(ref);
      if (!path) return NOT_FOUND;
      const moved = await repository.moveStatus(ref, ['MAPPING', 'AWAITING_BRANCH'], 'BUILDING');
      // Not moved: fine if a repeat of this step got there first (at-least-once delivery).
      if (!moved) {
        const now = await repository.findForJob(ref);
        if (now?.status !== 'BUILDING' && now?.status !== 'READY') return NOT_FOUND;
      }
      return {
        status: 'built',
        cut: cutPath(outline, path.level, branch, resourceCount, limits.cut),
      };
    },

    /**
     * The hook, from the official resource's opening. A path without a hook is still a path:
     * the model failing on the last attempt leaves it out.
     */
    async hook(
      ref: PathRef,
      cut: CutPath,
      { isLastAttempt }: StepAttempt,
    ): Promise<HookStepResult> {
      const path = await repository.findForJob(ref);
      if (!path) return NOT_FOUND;
      const resources = await repository.readResources(ref);
      const main = resources.find((r) => r.role === 'OFFICIAL') ?? resources[0];
      const source = main
        ? await repository.resourceText(ref, main.resourceId, limits.hookSourceChars)
        : undefined;
      try {
        const hook = await traced(ref, 'learning-path-hook', () =>
          generateHook(
            {
              topic: path.topic,
              level: path.level,
              moduleTitles: cut.modules.map((m) => m.title),
              resourceTitle: source?.title ?? path.topic,
              resourceText: source?.text ?? '',
            },
            { llm },
          ),
        );
        return { status: 'hooked', hook };
      } catch (err) {
        if (!isLastAttempt && isRetryable(err)) throw err;
        logger.warn({ err, ...ref }, 'path hook not written; the path goes without one');
        return { status: 'hooked', hook: null };
      }
    },

    async save(
      ref: PathRef,
      outline: Outline,
      cut: CutPath,
      hook: PathHook | null,
    ): Promise<SaveStepResult> {
      const rows = toOutlineRows(outline, cut, hook);
      if ((await repository.saveOutline(ref, rows)) === 'not_found') return NOT_FOUND;
      const included = rows.concepts.filter((c) => c.status === 'INCLUDED').length;
      return {
        status: 'ready',
        modules: rows.modules.length,
        included,
        skipped: rows.concepts.length - included,
      };
    },
  };
}

export type LearningPathOutlineService = ReturnType<typeof createLearningPathOutlineService>;
