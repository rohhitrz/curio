import type { Lesson, Module } from '@curio/shared';
import type { Logger } from 'pino';
import {
  citations as citationLimits,
  lessons as lessonLimits,
  locks,
  quotas,
} from '../config/index.js';
import { AppError, NotFoundError, ServiceUnavailableError } from '../errors/app-error.js';
import type { LlmProvider } from '../lib/llm/index.js';
import type { Lock, LockProvider } from '../lib/locks/index.js';
import type { Tracer } from '../lib/tracing/index.js';
import { buildLessonContext } from '../pipelines/lessons/context.js';
import { generateLesson } from '../pipelines/lessons/generate.js';
import { retrieveForConcepts } from '../pipelines/lessons/retrieve.js';
import { formatLearnerProfile } from '../pipelines/memory/profile.js';
import type { RetrievalPipelineDeps } from '../pipelines/retrieval/pipeline.js';
import type { LearningPathsRepository } from '../repositories/learning-paths.repository.js';
import type { LessonRow, LessonsRepository } from '../repositories/lessons.repository.js';
import type { MemoriesRepository } from '../repositories/memories.repository.js';
import { failureEvent, type ChatRun } from './chat.service.js';
import { toModule } from './learning-paths.service.js';

export interface LessonsServiceDeps {
  repository: LessonsRepository;
  paths: Pick<LearningPathsRepository, 'findModule'>;
  memories: Pick<MemoriesRepository, 'forNotebook'>;
  /** Flags and steps, as chat gets them; `step` is set here to trace each one. */
  retrieval: Omit<RetrievalPipelineDeps, 'step'>;
  llm: LlmProvider;
  tracer: Tracer;
  locks: LockProvider;
  countTokens: (text: string) => number;
  logger: Logger;
}

const status = {
  studying: 'Studying your resources…',
  writing: 'Writing the lesson…',
};

const moduleNotFound = () => new NotFoundError('Module not found.');

export function toLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    moduleId: row.moduleId,
    version: row.version,
    status: row.status,
    model: row.model,
    content: row.content,
    citations: row.citations,
    conversationId: row.conversationId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Lessons (docs/02-system-design.md §9, decision L-10): streamed live when a module is opened,
 * saved as versions. Generation reuses the chat stream format, so `start` carries the lesson ID.
 */
export function createLessonsService(deps: LessonsServiceDeps) {
  const { repository, tracer, logger } = deps;

  async function release(lock: Lock, moduleId: string) {
    try {
      await lock.release();
    } catch (err) {
      // It expires on its own.
      logger.warn({ err, moduleId }, 'lesson lock not released');
    }
  }

  /** Renews the lock while the lesson is written, so a slow one never outlives it. */
  function keepAlive(lock: Lock, moduleId: string): () => void {
    const timer = setInterval(() => {
      lock.extend(locks.lessonTtlSeconds).then(
        (held) => {
          if (!held) logger.warn({ moduleId }, 'lesson lock lost while writing');
        },
        (err: unknown) => {
          logger.warn({ err, moduleId }, 'lesson lock not renewed');
        },
      );
    }, locks.lessonRenewSeconds * 1000);
    return () => clearInterval(timer);
  }

  async function loadProfile(userId: string, notebookId: string) {
    try {
      return formatLearnerProfile(await deps.memories.forNotebook(userId, notebookId));
    } catch (err) {
      // Memory only shapes tone: teach without it rather than fail.
      logger.warn({ err, notebookId }, 'memories not loaded; lesson written without');
      return null;
    }
  }

  return {
    async latest(userId: string, moduleId: string): Promise<Lesson> {
      const row = await repository.latest(userId, moduleId);
      if (row) return toLesson(row);
      if (!(await repository.moduleExists(userId, moduleId))) throw moduleNotFound();
      throw new AppError('LESSON_NOT_GENERATED', 'This module has no lesson yet.');
    },

    async get(userId: string, lessonId: string): Promise<Lesson> {
      const row = await repository.findById(userId, lessonId);
      if (!row) throw new NotFoundError('Lesson not found.');
      return toLesson(row);
    },

    /**
     * Checks (path `READY`, module enabled, not generating) and takes the module's lock before
     * anything is streamed, so 404 / 409 are normal responses. Every call writes a new version.
     */
    async generate(userId: string, moduleId: string): Promise<ChatRun> {
      const module = await repository.forGeneration(userId, moduleId);
      if (!module) throw moduleNotFound();
      if (module.pathStatus !== 'READY') {
        throw new AppError('PATH_NOT_READY', 'This path is not ready yet.');
      }
      if (!module.isEnabled) {
        throw new AppError('MODULE_DISABLED', 'This module is turned off. Turn it on to learn it.');
      }
      let lock: Lock | null;
      try {
        lock = await deps.locks.acquire(`lesson:${module.id}`, locks.lessonTtlSeconds);
      } catch (err) {
        throw new ServiceUnavailableError(undefined, { cause: err });
      }
      if (!lock) {
        throw new AppError('LESSON_GENERATING', 'This lesson is still being written. Please wait.');
      }
      const held = lock;

      return {
        async run(sink) {
          const lessonId = crypto.randomUUID();
          let traceId: string | null = null;
          let text = '';
          let model = 'unknown';
          const stopKeepAlive = keepAlive(held, module.id);
          sink({ type: 'start', messageId: lessonId });

          try {
            await tracer.trace(
              {
                name: 'lesson',
                userId,
                input: module.title,
                metadata: { moduleId: module.id, pathId: module.pathId },
              },
              async (trace) => {
                traceId = trace.traceId;
                sink({ type: 'status', message: status.studying });

                const [found, profile] = await Promise.all([
                  tracer.span(
                    'retrieve',
                    { concepts: module.concepts.map((c) => c.name) },
                    () =>
                      retrieveForConcepts(
                        {
                          userId,
                          notebookId: module.notebookId,
                          concepts: module.concepts,
                          chunksPerConcept: lessonLimits.chunksPerConcept,
                          concurrency: lessonLimits.retrievalConcurrency,
                        },
                        {
                          ...deps.retrieval,
                          step: (name, input, fn) => tracer.span(name, input, fn),
                          onStepFailed: (step, err) => {
                            logger.warn(
                              { err, step, moduleId: module.id },
                              'lesson retrieval step failed; skipped',
                            );
                          },
                        },
                      ),
                    (out) =>
                      out.passages.map((p, i) => ({
                        concept: p.concept.name,
                        gated: out.results[i]?.gated ?? false,
                        chunks: p.chunks.map((c) => ({ chunkId: c.chunkId, score: c.score })),
                      })),
                  ),
                  loadProfile(userId, module.notebookId),
                ]);
                const context = buildLessonContext(found.passages, {
                  maxTokens: lessonLimits.contextMaxTokens,
                  countTokens: deps.countTokens,
                });

                sink({ type: 'status', message: status.writing });
                const stream = generateLesson(
                  {
                    topic: module.topic,
                    level: module.level,
                    goal: module.goal,
                    module: { title: module.title, summary: module.summary, why: module.why },
                    previous: module.previous,
                    profile,
                    context,
                  },
                  { llm: deps.llm, snippetMaxChars: citationLimits.snippetMaxChars },
                );
                for await (const delta of stream.textStream) {
                  text += delta;
                  sink({ type: 'text', delta });
                }
                const lesson = await stream.result;
                model = lesson.model;

                const saved = await repository.save(userId, lessonId, {
                  moduleId: module.id,
                  content: lesson.text,
                  citations: lesson.citations,
                  status: 'COMPLETE',
                  traceId,
                  model: lesson.model,
                });
                if (!saved) throw moduleNotFound();
                trace.setOutput({
                  citations: lesson.citations.length,
                  removedMarkers: lesson.removedMarkers,
                  generalKnowledge: context.concepts
                    .filter((c) => c.markers.length === 0)
                    .map((c) => c.concept.name),
                  profile: profile !== null,
                });
                sink({ type: 'citations', citations: lesson.citations });
                sink({ type: 'finish', traceId });
              },
            );
          } catch (err) {
            logger.error({ err, moduleId: module.id, traceId }, 'lesson failed');
            try {
              await repository.save(userId, lessonId, {
                moduleId: module.id,
                content: text,
                citations: [],
                status: 'ERROR',
                traceId,
                model,
              });
            } catch (saveErr) {
              logger.error({ err: saveErr, moduleId: module.id }, 'ERROR lesson not saved');
            }
            sink({ type: 'error', ...failureEvent(err) });
            sink({ type: 'finish', traceId });
          } finally {
            stopKeepAlive();
            await release(held, module.id);
            await tracer.flush().catch((err: unknown) => {
              logger.warn({ err }, 'trace flush failed');
            });
          }
        },
      };
    },

    /**
     * Marks a module done (writing `UNDERSTOOD` memories for its concepts) or not done
     * (removing them). Returns the module.
     */
    async setCompletion(userId: string, moduleId: string, completed: boolean): Promise<Module> {
      const done = await repository.setCompletion(
        userId,
        moduleId,
        completed,
        quotas.memoriesPerUser,
      );
      if (!done) throw moduleNotFound();
      const row = await deps.paths.findModule(userId, moduleId);
      if (!row) throw moduleNotFound();
      return toModule(row);
    },
  };
}

export type LessonsService = ReturnType<typeof createLessonsService>;
