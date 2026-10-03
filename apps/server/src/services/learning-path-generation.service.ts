import { SOURCE_TITLE_MAX, type Level } from '@curio/shared';
import type { Logger } from 'pino';
import { LlmError } from '../errors/llm-error.js';
import { SearchError } from '../errors/search-error.js';
import type { LlmProvider } from '../lib/llm/index.js';
import type { SearchProvider, SearchResult } from '../lib/search/index.js';
import type { Tracer } from '../lib/tracing/index.js';
import {
  fallbackJudgements,
  judgeCandidates,
  searchRequests,
  selectResources,
  toCandidates,
  type Candidate,
  type GatherLimits,
  type SearchPurpose,
  type SelectedResource,
} from '../pipelines/learning/gather.js';
import type {
  LearningPathsRepository,
  NewPathResource,
  PathRef,
} from '../repositories/learning-paths.repository.js';
import { normalizeUrl, sha256Hex } from './source-identity.js';

/** Why a path failed; shown with its message on the progress screen. */
export type PathErrorCode =
  | 'SEARCH_FAILED'
  | 'NO_RESOURCES'
  | 'TOO_FEW_RESOURCES'
  | 'BRANCH_NOT_PICKED'
  | 'GENERATION_FAILED';

export const pathMessages = {
  searchFailed: "We couldn't search the web for resources right now. Please try again.",
  noResources: "We couldn't find enough good resources for this topic. Try wording it differently.",
  tooFew: (ready: number, total: number, min: number) =>
    `Only ${String(ready)} of ${String(total)} resources could be read, and a path needs at least ${String(min)}. Please try again.`,
  tooFewMapped: (mapped: number, total: number, min: number) =>
    `Only ${String(mapped)} of ${String(total)} resources could be turned into concepts, and a path needs at least ${String(min)}. Please try again.`,
  branchNotPicked: 'No branch was picked in time. Retry to build the path again.',
  failed: 'Something went wrong while building this path. Please try again.',
};

export type Stopped =
  | { status: 'stopped'; reason: 'not_found' | 'not_gathering' }
  | { status: 'stopped'; reason: 'failed'; code: PathErrorCode };

export type ClaimResult = { status: 'claimed'; hasResources: boolean; level: Level } | Stopped;
export type SearchStepResult = { status: 'searched'; candidates: Candidate[] } | Stopped;
export type SelectStepResult = { status: 'selected'; resources: SelectedResource[] } | Stopped;
/** `ingest`: the sources the job still has to read (`PENDING`). */
export type SaveStepResult = { status: 'saved'; ingest: string[] } | Stopped;
export type ReadingResult =
  | { status: 'read'; ready: number; total: number }
  | { status: 'in_flight'; inFlight: number }
  | Stopped;

/** Fails the path with a reason (unless it is `READY`); our own faults are logged as errors. */
export async function failPath(
  deps: { repository: LearningPathsRepository; logger: Logger },
  ref: PathRef,
  code: PathErrorCode,
  message: string,
): Promise<Stopped> {
  const level = code === 'GENERATION_FAILED' || code === 'SEARCH_FAILED' ? 'error' : 'warn';
  deps.logger[level]({ ...ref, code }, 'learning path failed');
  const marked = await deps.repository.markFailed(ref, code, message);
  return marked
    ? { status: 'stopped', reason: 'failed', code }
    : { status: 'stopped', reason: 'not_found' };
}

export interface StepAttempt {
  /** True on the last try: a transient failure now fails the path (or degrades) instead. */
  isLastAttempt: boolean;
}

export interface LearningPathGenerationDeps {
  repository: LearningPathsRepository;
  search: SearchProvider;
  llm: LlmProvider;
  tracer: Tracer;
  logger: Logger;
  limits: GatherLimits & { minResources: number };
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof SearchError || err instanceof LlmError) return err.retryable;
  return true;
}

/** How a selected resource is stored: the same identity rules as a source the user adds. */
function toNewResource(resource: SelectedResource): NewPathResource {
  const title = resource.title.slice(0, SOURCE_TITLE_MAX);
  const source: NewPathResource['source'] = resource.videoId
    ? {
        type: 'YOUTUBE',
        title,
        contentHash: sha256Hex(resource.url),
        metadata: { videoId: resource.videoId },
      }
    : { type: 'WEBSITE', title, contentHash: sha256Hex(normalizeUrl(resource.url)), metadata: {} };
  return {
    role: resource.role,
    resourceType: resource.resourceType,
    title: resource.title,
    url: resource.url,
    source,
  };
}

/**
 * The `generateLearningPath` job's steps, part 1 (docs/02-system-design.md §8): gather resources,
 * save them as sources of the path's notebook, and check enough of them were read.
 */
export function createLearningPathGenerationService(deps: LearningPathGenerationDeps) {
  const { repository, search, llm, tracer, logger, limits } = deps;

  const fail = (ref: PathRef, code: PathErrorCode, message: string) =>
    failPath({ repository, logger }, ref, code, message);

  return {
    /** Only a `GATHERING` path is built, so a duplicate event's run stops here. */
    async claim(ref: PathRef): Promise<ClaimResult> {
      const path = await repository.findForJob(ref);
      if (!path) return { status: 'stopped', reason: 'not_found' };
      if (path.status !== 'GATHERING') return { status: 'stopped', reason: 'not_gathering' };
      const resources = await repository.listResources(ref);
      return { status: 'claimed', hasResources: resources.length > 0, level: path.level };
    },

    /** The three searches, together. Some failing is fine; all failing retries, then fails. */
    async search(ref: PathRef, { isLastAttempt }: StepAttempt): Promise<SearchStepResult> {
      const path = await repository.findForJob(ref);
      if (!path) return { status: 'stopped', reason: 'not_found' };

      const planned = searchRequests(path, limits);
      const settled = await Promise.allSettled(planned.map((p) => search.search(p.request)));
      const found: { purpose: SearchPurpose; results: SearchResult[] }[] = [];
      const errors: unknown[] = [];
      settled.forEach((outcome, i) => {
        const purpose = planned[i]?.purpose;
        if (!purpose) return;
        if (outcome.status === 'fulfilled') found.push({ purpose, results: outcome.value });
        else errors.push(outcome.reason);
      });
      for (const err of errors) logger.warn({ err, ...ref }, 'learning path search failed');

      if (found.length === 0) {
        if (!isLastAttempt && errors.some(isRetryable)) throw errors[0];
        return fail(ref, 'SEARCH_FAILED', pathMessages.searchFailed);
      }
      const candidates = toCandidates(found);
      if (candidates.length === 0) return fail(ref, 'NO_RESOURCES', pathMessages.noResources);
      return { status: 'searched', candidates };
    },

    /**
     * The model judges the candidates; code picks the resources. The model unreachable on the
     * last attempt → search order decides instead (logged), rather than failing the path.
     */
    async select(
      ref: PathRef,
      candidates: Candidate[],
      { isLastAttempt }: StepAttempt,
    ): Promise<SelectStepResult> {
      const path = await repository.findForJob(ref);
      if (!path) return { status: 'stopped', reason: 'not_found' };

      let judgements;
      try {
        judgements = await tracer.trace(
          {
            name: 'learning-path-selection',
            userId: ref.userId,
            metadata: { pathId: ref.pathId, candidates: String(candidates.length) },
          },
          () => judgeCandidates(path, candidates, { llm, snippetMaxChars: limits.snippetMaxChars }),
        );
      } catch (err) {
        if (!isLastAttempt && isRetryable(err)) throw err;
        logger.error({ err, ...ref }, 'resource selection failed; using search order');
        judgements = fallbackJudgements(candidates);
      }

      const resources = selectResources(candidates, judgements, limits);
      if (resources.length < limits.minResources) {
        return fail(ref, 'NO_RESOURCES', pathMessages.noResources);
      }
      return { status: 'selected', resources };
    },

    /**
     * Saves the resources (kept as they are if the path already has some: a retry reuses what
     * was read) and puts failed sources back to `PENDING`, to be read again.
     */
    async save(ref: PathRef, resources: SelectedResource[]): Promise<SaveStepResult> {
      const saved = await repository.saveResources(ref, resources.map(toNewResource));
      if (!saved) return { status: 'stopped', reason: 'not_found' };
      await repository.resetFailedSources(ref);
      const listed = await repository.listResources(ref);
      return {
        status: 'saved',
        ingest: listed.flatMap((r) =>
          r.sourceId && r.sourceStatus === 'PENDING' ? [r.sourceId] : [],
        ),
      };
    },

    /**
     * After the ingestion runs: enough sources `READY` → `MAPPING`; too few → `FAILED` with the
     * count. Sources still being read are waited for (`in_flight`) unless this is the last check,
     * when they count as not read. A resource whose source the user deleted counts as not read.
     */
    async finishReading(
      ref: PathRef,
      { lastCheck }: { lastCheck: boolean },
    ): Promise<ReadingResult> {
      const path = await repository.findForJob(ref);
      if (!path) return { status: 'stopped', reason: 'not_found' };
      const resources = await repository.listResources(ref);
      const inFlight = resources.filter(
        (r) => r.sourceStatus === 'PENDING' || r.sourceStatus === 'PROCESSING',
      ).length;
      if (inFlight > 0 && !lastCheck) return { status: 'in_flight', inFlight };

      const ready = resources.filter((r) => r.sourceStatus === 'READY').length;
      if (ready < limits.minResources) {
        return fail(
          ref,
          'TOO_FEW_RESOURCES',
          pathMessages.tooFew(ready, resources.length, limits.minResources),
        );
      }
      // A repeated step (at-least-once delivery) finds the path already moved on.
      const moved =
        (await repository.moveStatus(ref, ['READING'], 'MAPPING')) ||
        (await repository.findForJob(ref))?.status === 'MAPPING';
      if (!moved) return { status: 'stopped', reason: 'not_found' };
      return { status: 'read', ready, total: resources.length };
    },

    /** A step still throwing on its last attempt (e.g. the database was down). */
    async failUnexpectedly(ref: PathRef): Promise<void> {
      await fail(ref, 'GENERATION_FAILED', pathMessages.failed);
    },
  };
}

export type LearningPathGenerationService = ReturnType<typeof createLearningPathGenerationService>;
