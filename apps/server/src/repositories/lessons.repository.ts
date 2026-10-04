import type { CitationSnapshot } from '@curio/shared';
import { and, asc, count, desc, eq, inArray, lt, max, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  concepts,
  conversations,
  learningPaths,
  lessons,
  memories,
  modules,
  notebooks,
} from '../db/schema/index.js';

const lessonColumns = {
  id: lessons.id,
  moduleId: lessons.moduleId,
  version: lessons.version,
  status: lessons.status,
  model: lessons.model,
  content: lessons.content,
  citations: lessons.citations,
  traceId: lessons.traceId,
  createdAt: lessons.createdAt,
};

export type LessonRow = typeof lessons.$inferSelect & { conversationId: string | null };

export interface NewLesson {
  moduleId: string;
  content: string;
  citations: CitationSnapshot[];
  status: 'COMPLETE' | 'ERROR';
  traceId: string | null;
  model: string;
}

/** A module the user owns, joined up to its path (every lesson query goes through this). */
const ownedModule = (userId: string, moduleId: string) =>
  and(eq(modules.id, moduleId), eq(learningPaths.userId, userId));

/** Every query is scoped by `userId` through module → path; another user's lesson reads as missing. */
export function createLessonsRepository(db: Db) {
  /** The module's latest tutor conversation: linked to any version of its lesson. */
  async function tutorConversationId(userId: string, moduleId: string): Promise<string | null> {
    const [row] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(lessons, eq(lessons.id, conversations.lessonId))
      .where(and(eq(lessons.moduleId, moduleId), eq(conversations.userId, userId)))
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(1);
    return row?.id ?? null;
  }

  return {
    /**
     * What a lesson is written from: the module, its path, the module before it, and its
     * included concepts in order. Undefined when the module isn't the user's.
     */
    async forGeneration(userId: string, moduleId: string) {
      const [row] = await db
        .select({
          id: modules.id,
          pathId: modules.pathId,
          position: modules.position,
          title: modules.title,
          summary: modules.summary,
          why: modules.why,
          isEnabled: modules.isEnabled,
          pathStatus: learningPaths.status,
          topic: learningPaths.topic,
          level: learningPaths.level,
          goal: learningPaths.goal,
          notebookId: learningPaths.notebookId,
        })
        .from(modules)
        .innerJoin(learningPaths, eq(learningPaths.id, modules.pathId))
        .where(ownedModule(userId, moduleId))
        .limit(1);
      if (!row) return undefined;
      const [previous] = await db
        .select({ title: modules.title, summary: modules.summary })
        .from(modules)
        .where(and(eq(modules.pathId, row.pathId), lt(modules.position, row.position)))
        .orderBy(desc(modules.position))
        .limit(1);
      const taught = await db
        .select({ id: concepts.id, name: concepts.name, description: concepts.description })
        .from(concepts)
        .where(and(eq(concepts.moduleId, row.id), eq(concepts.status, 'INCLUDED')))
        .orderBy(asc(concepts.position), asc(concepts.name));
      return { ...row, previous: previous ?? null, concepts: taught };
    },

    async moduleExists(userId: string, moduleId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: modules.id })
        .from(modules)
        .innerJoin(learningPaths, eq(learningPaths.id, modules.pathId))
        .where(ownedModule(userId, moduleId))
        .limit(1);
      return row !== undefined;
    },

    /** The latest complete version, with the module's tutor conversation. */
    async latest(userId: string, moduleId: string): Promise<LessonRow | undefined> {
      const [row] = await db
        .select(lessonColumns)
        .from(lessons)
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .innerJoin(learningPaths, eq(learningPaths.id, modules.pathId))
        .where(and(ownedModule(userId, moduleId), eq(lessons.status, 'COMPLETE')))
        .orderBy(desc(lessons.version))
        .limit(1);
      if (!row) return undefined;
      return { ...row, conversationId: await tutorConversationId(userId, moduleId) };
    },

    async findById(userId: string, lessonId: string): Promise<LessonRow | undefined> {
      const [row] = await db
        .select(lessonColumns)
        .from(lessons)
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .innerJoin(learningPaths, eq(learningPaths.id, modules.pathId))
        .where(and(eq(lessons.id, lessonId), eq(learningPaths.userId, userId)))
        .limit(1);
      if (!row) return undefined;
      return { ...row, conversationId: await tutorConversationId(userId, row.moduleId) };
    },

    /** True when the lesson is the user's and belongs to this notebook (a tutor chat's link). */
    async inNotebook(userId: string, lessonId: string, notebookId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: lessons.id })
        .from(lessons)
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .innerJoin(learningPaths, eq(learningPaths.id, modules.pathId))
        .where(
          and(
            eq(lessons.id, lessonId),
            eq(learningPaths.userId, userId),
            eq(learningPaths.notebookId, notebookId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    /**
     * What the tutor of a lesson version knows: the lesson, the sources it cites (what its chat
     * searches), its module and the path's modules in order. Undefined when it isn't the user's.
     */
    async tutorContext(userId: string, lessonId: string) {
      const [row] = await db
        .select({
          content: lessons.content,
          citations: lessons.citations,
          moduleId: modules.id,
          title: modules.title,
          summary: modules.summary,
          why: modules.why,
          pathId: modules.pathId,
        })
        .from(lessons)
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .innerJoin(learningPaths, eq(learningPaths.id, modules.pathId))
        .where(and(eq(lessons.id, lessonId), eq(learningPaths.userId, userId)))
        .limit(1);
      if (!row) return undefined;
      const all = await db
        .select({
          id: modules.id,
          title: modules.title,
          summary: modules.summary,
          completedAt: modules.completedAt,
        })
        .from(modules)
        .where(and(eq(modules.pathId, row.pathId), eq(modules.isEnabled, true)))
        .orderBy(asc(modules.position));
      return {
        lesson: row.content,
        sourceIds: [...new Set(row.citations.map((c) => c.sourceId))],
        module: { id: row.moduleId, title: row.title, summary: row.summary, why: row.why },
        modules: all.map((m) => ({
          id: m.id,
          title: m.title,
          summary: m.summary,
          done: m.completedAt !== null,
        })),
      };
    },

    /**
     * Saves the next version of the module's lesson (the module row is locked, so two saves
     * can't take the same number). Undefined when the module is gone.
     */
    async save(
      userId: string,
      lessonId: string,
      lesson: NewLesson,
    ): Promise<LessonRow | undefined> {
      const row = await db.transaction(async (tx) => {
        const [module] = await tx
          .select({ id: modules.id })
          .from(modules)
          .innerJoin(learningPaths, eq(learningPaths.id, modules.pathId))
          .where(ownedModule(userId, lesson.moduleId))
          .for('update', { of: modules });
        if (!module) return undefined;
        const [last] = await tx
          .select({ version: max(lessons.version) })
          .from(lessons)
          .where(eq(lessons.moduleId, module.id));
        const [saved] = await tx
          .insert(lessons)
          .values({ id: lessonId, ...lesson, version: (last?.version ?? 0) + 1 })
          .returning();
        return saved;
      });
      if (!row) return undefined;
      return { ...row, conversationId: await tutorConversationId(userId, row.moduleId) };
    },

    /**
     * Marks the module done (`completed_at`) and writes an `UNDERSTOOD` memory per included
     * concept (origin `LESSON_COMPLETED`, `origin_ref` = the module), or un-marks it and removes
     * those memories, in one transaction (docs/04-api-design.md §6). A concept already
     * remembered keeps its memory; new ones stop at the memory cap. Undefined when the module
     * isn't the user's.
     */
    async setCompletion(
      userId: string,
      moduleId: string,
      completed: boolean,
      memoryCap: number,
    ): Promise<{ id: string; memoriesAdded: number } | undefined> {
      return db.transaction(async (tx) => {
        const [module] = await tx
          .select({ id: modules.id, topicId: notebooks.topicId })
          .from(modules)
          .innerJoin(learningPaths, eq(learningPaths.id, modules.pathId))
          .innerJoin(notebooks, eq(notebooks.id, learningPaths.notebookId))
          .where(ownedModule(userId, moduleId))
          .for('update', { of: modules });
        if (!module) return undefined;

        if (!completed) {
          await tx.update(modules).set({ completedAt: null }).where(eq(modules.id, module.id));
          await tx
            .delete(memories)
            .where(
              and(
                eq(memories.userId, userId),
                eq(memories.origin, 'LESSON_COMPLETED'),
                eq(memories.originRef, module.id),
              ),
            );
          return { id: module.id, memoriesAdded: 0 };
        }

        await tx
          .update(modules)
          .set({ completedAt: sql`coalesce(${modules.completedAt}, now())` })
          .where(eq(modules.id, module.id));
        if (!module.topicId) return { id: module.id, memoriesAdded: 0 };

        // Same lock as every other memory write, so the cap can't be overshot.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`memories:${userId}`}))`);
        const taught = await tx
          .select({ id: concepts.id, name: concepts.name })
          .from(concepts)
          .where(and(eq(concepts.moduleId, module.id), eq(concepts.status, 'INCLUDED')))
          .orderBy(asc(concepts.position));
        if (taught.length === 0) return { id: module.id, memoriesAdded: 0 };
        const known = new Set(
          (
            await tx
              .select({ conceptId: memories.conceptId })
              .from(memories)
              .where(
                and(
                  eq(memories.userId, userId),
                  eq(memories.kind, 'UNDERSTOOD'),
                  inArray(
                    memories.conceptId,
                    taught.map((c) => c.id),
                  ),
                ),
              )
          ).map((r) => r.conceptId),
        );
        const [used] = await tx
          .select({ n: count() })
          .from(memories)
          .where(eq(memories.userId, userId));
        const room = Math.max(0, memoryCap - (used?.n ?? 0));
        const fresh = taught.filter((c) => !known.has(c.id)).slice(0, room);
        if (fresh.length > 0) {
          await tx.insert(memories).values(
            fresh.map((c) => ({
              userId,
              scope: 'TOPIC' as const,
              topicId: module.topicId,
              kind: 'UNDERSTOOD' as const,
              content: c.name,
              conceptId: c.id,
              origin: 'LESSON_COMPLETED' as const,
              originRef: module.id,
            })),
          );
        }
        return { id: module.id, memoriesAdded: fresh.length };
      });
    },
  };
}

export type LessonsRepository = ReturnType<typeof createLessonsRepository>;
