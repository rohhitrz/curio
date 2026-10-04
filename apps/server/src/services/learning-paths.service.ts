import {
  NOTEBOOK_TITLE_MAX,
  TOPIC_NAME_MAX,
  type LearningPath,
  type Level,
  type Module,
  type Outline,
  type PrefillResponse,
  type ResourceState,
  type ScopeResponse,
  type StartPathInput,
  type StartPathResponse,
} from '@curio/shared';
import type { Logger } from 'pino';
import { learningPaths as learningPathsConfig, quotas } from '../config/index.js';
import { AppError, NotFoundError, ValidationError } from '../errors/app-error.js';
import type { EmbeddingsProvider } from '../lib/embeddings/index.js';
import type { JobsProvider } from '../lib/jobs/index.js';
import type { LlmProvider } from '../lib/llm/index.js';
import type { Tracer } from '../lib/tracing/index.js';
import { moduleMinutes } from '../pipelines/learning/minutes.js';
import { checkScope, NOT_BROAD, toScopeResult } from '../pipelines/learning/scope.js';
import type {
  LearningPathsRepository,
  PathRow,
} from '../repositories/learning-paths.repository.js';
import type { MemoriesRepository } from '../repositories/memories.repository.js';
import type { TopicsRepository } from '../repositories/topics.repository.js';
import type { TopicsService } from './topics.service.js';
import { normalizeTopicName } from './topics.service.js';

const pathNotFound = () => new NotFoundError('Learning path not found.');
const notStarted = "We couldn't start building this path. Please retry.";

type ResourceRow = Awaited<ReturnType<LearningPathsRepository['listResources']>>[number];

/** Where a resource stands, for the progress screen. A deleted source counts as read. */
export function resourceState(r: Pick<ResourceRow, 'sourceStatus' | 'mappedAt'>): ResourceState {
  if (r.mappedAt) return 'MAPPED';
  if (r.sourceStatus === 'FAILED') return 'FAILED';
  if (r.sourceStatus === 'PENDING' || r.sourceStatus === 'PROCESSING') return 'READING';
  return 'READ';
}

function toPath(row: PathRow, resources: ResourceRow[]): LearningPath {
  return {
    id: row.id,
    notebookId: row.notebookId,
    topic: row.topic,
    level: row.level,
    goal: row.goal,
    status: row.status,
    branchOptions: row.branchOptions ?? null,
    selectedBranch: row.selectedBranch,
    hook: row.hook ?? null,
    resources: resources.map((r) => ({ id: r.id, title: r.title, state: resourceState(r) })),
    error:
      row.status === 'FAILED' && row.errorCode
        ? { code: row.errorCode, message: row.errorMessage ?? '' }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toModule(row: {
  id: string;
  position: number;
  title: string;
  summary: string;
  why: string | null;
  difficulty: Level | null;
  isEnabled: boolean;
  completedAt: Date | null;
  hasLesson: boolean;
}): Module {
  return {
    id: row.id,
    position: row.position,
    title: row.title,
    summary: row.summary,
    why: row.why,
    difficulty: row.difficulty,
    isEnabled: row.isEnabled,
    completedAt: row.completedAt?.toISOString() ?? null,
    hasLesson: row.hasLesson,
  };
}

export function createLearningPathsService(deps: {
  topics: TopicsRepository;
  topicsService: TopicsService;
  memories: MemoriesRepository;
  paths: LearningPathsRepository;
  embeddings: EmbeddingsProvider;
  llm: LlmProvider;
  tracer: Tracer;
  jobs: JobsProvider;
  logger: Logger;
}) {
  const { topics, topicsService, memories, paths, embeddings, llm, tracer, jobs, logger } = deps;

  /** Starts (or restarts) the job. Not queued → the path fails, so the learner can retry. */
  async function requestBuild(userId: string, pathId: string): Promise<boolean> {
    try {
      await jobs.send('path/requested', { pathId, userId });
      return true;
    } catch (err) {
      logger.error({ err, pathId }, 'path/requested not sent: path failed');
      await paths.markFailed({ userId, pathId }, 'GENERATION_FAILED', notStarted);
      return false;
    }
  }

  async function findOwn(userId: string, pathId: string): Promise<PathRow> {
    const row = await paths.findById(userId, pathId);
    if (!row) throw pathNotFound();
    return row;
  }

  async function withResources(userId: string, row: PathRow): Promise<LearningPath> {
    return toPath(row, await paths.listResources({ userId, pathId: row.id }));
  }

  return {
    /**
     * Learning notebook + path + `LEVEL` memory in one transaction, then the job is queued
     * (docs/04-api-design.md §6). The topic is found or created first (embeddings down → 503,
     * nothing created).
     */
    async start(userId: string, input: StartPathInput): Promise<StartPathResponse> {
      const topic = await topicsService.findOrCreate(input.topic);
      const result = await paths.createPath(
        userId,
        {
          title: input.topic.slice(0, NOTEBOOK_TITLE_MAX),
          topic: input.topic,
          topicId: topic.id,
          level: input.level,
          goal: input.goal,
          levelContent: `${input.level.toLowerCase()} in ${topic.name}`,
        },
        { notebooks: quotas.notebooksPerUser, memories: quotas.memoriesPerUser },
      );
      if (result.kind === 'quota') {
        throw new AppError(
          'QUOTA_EXCEEDED',
          `You can have up to ${String(quotas.notebooksPerUser)} notebooks. Delete one to start a new path.`,
        );
      }
      if (!result.levelSaved)
        logger.warn({ pathId: result.path.id }, 'level not saved: memory cap');
      const queued = await requestBuild(userId, result.path.id);
      return {
        pathId: result.path.id,
        notebookId: result.path.notebookId,
        status: queued ? result.path.status : 'FAILED',
      };
    },

    async get(userId: string, pathId: string): Promise<LearningPath> {
      return withResources(userId, await findOwn(userId, pathId));
    },

    /**
     * Saves the pick of a paused advanced path, then wakes the job (which reads the pick from
     * the database, so a lost wake-up only delays it until the job's next check).
     */
    async selectBranch(userId: string, pathId: string, branch: string): Promise<LearningPath> {
      const path = await findOwn(userId, pathId);
      if (path.status !== 'AWAITING_BRANCH') {
        throw new AppError('INVALID_STATE', 'This path is not waiting for a branch.');
      }
      if (!(path.branchOptions ?? []).some((option) => option.name === branch)) {
        throw new ValidationError({ branch: 'Not one of the branches offered.' });
      }
      const saved = await paths.selectBranch(userId, pathId, branch);
      if (!saved) throw new AppError('INVALID_STATE', 'This path is not waiting for a branch.');
      try {
        await jobs.send('path/branch-selected', { pathId, userId });
      } catch (err) {
        logger.warn({ err, pathId }, 'path/branch-selected not sent: the job finds the pick later');
      }
      return withResources(userId, saved);
    },

    /** A failed path, built again: what was read is reused; not counted against the daily limit. */
    async retry(userId: string, pathId: string): Promise<LearningPath> {
      const path = await findOwn(userId, pathId);
      if (path.status !== 'FAILED') {
        throw new AppError('INVALID_STATE', 'Only a failed path can be retried.');
      }
      const reset = await paths.resetForRetry(userId, pathId);
      if (!reset) throw new AppError('INVALID_STATE', 'Only a failed path can be retried.');
      await requestBuild(userId, pathId);
      return withResources(userId, await findOwn(userId, pathId));
    },

    async outline(userId: string, pathId: string): Promise<Outline> {
      const path = await findOwn(userId, pathId);
      if (path.status !== 'READY') {
        throw new AppError('PATH_NOT_READY', 'This path is not ready yet.');
      }
      const saved = await paths.outline(userId, pathId);
      const included = saved.concepts.filter((c) => c.status === 'INCLUDED' && c.moduleId);
      const modules = saved.modules.map((m) => {
        const own = included
          .filter((c) => c.moduleId === m.id)
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        return {
          ...toModule(m),
          minutes: moduleMinutes(own.length, path.level, learningPathsConfig.minutesPerConcept),
          concepts: own.map((c) => ({
            id: c.id,
            name: c.name,
            coveredBy: c.coveredBy,
            officialCovers: c.officialCovers,
          })),
        };
      });
      const enabled = modules.filter((m) => m.isEnabled);
      return {
        hook: path.hook ?? null,
        modules,
        skipped: saved.concepts
          .filter((c) => c.status === 'SKIPPED')
          .sort((a, b) => b.consensusScore - a.consensusScore || a.name.localeCompare(b.name))
          .map((c) => ({ name: c.name, reason: c.skipReason ?? '' })),
        resources: saved.resources.map((r) => ({
          id: r.id,
          title: r.title,
          url: r.url,
          role: r.role,
          type: r.resourceType,
          sourceId: r.sourceId,
        })),
        progress: {
          completed: enabled.filter((m) => m.completedAt !== null).length,
          enabled: enabled.length,
        },
      };
    },

    async updateModule(userId: string, moduleId: string, isEnabled: boolean): Promise<Module> {
      const row = await paths.setModuleEnabled(userId, moduleId, isEnabled);
      if (!row) throw new NotFoundError('Module not found.');
      return toModule(row);
    },

    /**
     * Is the topic focused enough for one path? Too broad → narrower topics to pick from (L-11).
     * Only a suggestion: the model failing → not broad, so starting is never blocked.
     */
    async scope(userId: string, topic: string, level: Level): Promise<ScopeResponse> {
      try {
        const output = await tracer.trace({ name: 'learning-path-scope', userId }, () =>
          checkScope({ topic, level }, { llm }),
        );
        return toScopeResult(output, {
          minOptions: learningPathsConfig.scopeMinOptions,
          maxOptions: learningPathsConfig.scopeMaxOptions,
          topicMax: TOPIC_NAME_MAX,
        });
      } catch (err) {
        logger.warn({ err }, 'scope check failed; topic treated as focused');
        return NOT_BROAD;
      }
    },

    /**
     * The level to pre-fill on the clarify screen: the one confirmed for this topic, else the
     * one of the most similar topic studied. Read-only: an unseen topic is embedded but not
     * created. Pre-fill is a convenience, so embeddings down → no match (the learner just picks).
     */
    async prefill(userId: string, topicName: string): Promise<PrefillResponse> {
      const levels = await memories.levels(userId);
      if (levels.length === 0) return { match: null };

      const topic = await topics.findWithEmbedding(normalizeTopicName(topicName));
      const exact = topic && levels.find((l) => l.topicId === topic.id);
      if (exact)
        return { match: { type: 'EXACT', topicName: exact.topicName, level: exact.level } };

      let embedding = topic?.embedding;
      if (!embedding) {
        try {
          [embedding] = await embeddings.embed([topicName]);
        } catch (err) {
          logger.warn({ err }, 'prefill: topic not embedded; no match offered');
          return { match: null };
        }
      }
      if (!embedding) return { match: null };

      const related = await memories.nearestLevel(userId, embedding, {
        minSimilarity: learningPathsConfig.relatedTopicMinSimilarity,
        ...(topic ? { excludeTopicId: topic.id } : {}),
      });
      return related
        ? { match: { type: 'RELATED', topicName: related.topicName, level: related.level } }
        : { match: null };
    },
  };
}

export type LearningPathsService = ReturnType<typeof createLearningPathsService>;
