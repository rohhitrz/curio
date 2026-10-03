import type { PathStatus, ResourceRole, ResourceType } from '@curio/shared';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { learningPaths, pathResources, sources } from '../db/schema/index.js';

/** A learning path as a job run sees it. */
export interface PathRef {
  pathId: string;
  userId: string;
}

/** A resource to save, with the source it is ingested as. */
export interface NewPathResource {
  role: ResourceRole;
  resourceType: ResourceType;
  title: string;
  url: string;
  source: {
    type: 'WEBSITE' | 'YOUTUBE';
    title: string;
    contentHash: string;
    metadata: Record<string, unknown>;
  };
}

const owned = (ref: PathRef) =>
  and(eq(learningPaths.id, ref.pathId), eq(learningPaths.userId, ref.userId));

/** Every query is scoped by `userId`; another user's path reads as missing. */
export function createLearningPathsRepository(db: Db) {
  async function listResources(ref: PathRef) {
    return db
      .select({
        id: pathResources.id,
        role: pathResources.role,
        resourceType: pathResources.resourceType,
        title: pathResources.title,
        url: pathResources.url,
        sourceId: pathResources.sourceId,
        sourceStatus: sources.status,
      })
      .from(pathResources)
      .innerJoin(learningPaths, eq(learningPaths.id, pathResources.pathId))
      .leftJoin(sources, eq(sources.id, pathResources.sourceId))
      .where(owned(ref))
      .orderBy(asc(pathResources.role), asc(pathResources.id));
  }

  return {
    listResources,

    async findForJob(ref: PathRef) {
      const [row] = await db
        .select({
          id: learningPaths.id,
          notebookId: learningPaths.notebookId,
          topic: learningPaths.topic,
          level: learningPaths.level,
          goal: learningPaths.goal,
          status: learningPaths.status,
        })
        .from(learningPaths)
        .where(owned(ref))
        .limit(1);
      return row;
    },

    /** Moves the path to `to` if it is in one of `from`. False when it wasn't (or is gone). */
    async moveStatus(ref: PathRef, from: PathStatus[], to: PathStatus): Promise<boolean> {
      const rows = await db
        .update(learningPaths)
        .set({ status: to })
        .where(and(owned(ref), inArray(learningPaths.status, from)))
        .returning({ id: learningPaths.id });
      return rows.length > 0;
    },

    /** Fails the path with a reason, unless it is already `READY`. False when nothing changed. */
    async markFailed(ref: PathRef, code: string, message: string): Promise<boolean> {
      const rows = await db
        .update(learningPaths)
        .set({ status: 'FAILED', errorCode: code, errorMessage: message })
        .where(and(owned(ref), ne(learningPaths.status, 'READY')))
        .returning({ id: learningPaths.id });
      return rows.length > 0;
    },

    /**
     * Saves the gathered resources and their sources (origin `LEARNING_PATH`, `PENDING`, nobody
     * told: the job invokes their ingestion itself) and moves the path to `READING`, in one
     * transaction. A path that already has resources (a retried step, or a retried path) keeps
     * them. Undefined when the path is gone.
     */
    async saveResources(ref: PathRef, resources: NewPathResource[]) {
      const saved = await db.transaction(async (tx) => {
        const [path] = await tx
          .select({ id: learningPaths.id, notebookId: learningPaths.notebookId })
          .from(learningPaths)
          .where(owned(ref))
          .for('update');
        if (!path) return false;

        const [existing] = await tx
          .select({ id: pathResources.id })
          .from(pathResources)
          .where(eq(pathResources.pathId, path.id))
          .limit(1);
        if (!existing) {
          for (const resource of resources) {
            const [inserted] = await tx
              .insert(sources)
              .values({
                ...resource.source,
                notebookId: path.notebookId,
                userId: ref.userId,
                origin: 'LEARNING_PATH',
                url: resource.url,
              })
              // The user may have added the same page to the notebook meanwhile: reuse it.
              .onConflictDoNothing({ target: [sources.notebookId, sources.contentHash] })
              .returning({ id: sources.id });
            const sourceId =
              inserted?.id ??
              (
                await tx
                  .select({ id: sources.id })
                  .from(sources)
                  .where(
                    and(
                      eq(sources.notebookId, path.notebookId),
                      eq(sources.contentHash, resource.source.contentHash),
                    ),
                  )
              )[0]?.id;
            await tx.insert(pathResources).values({
              pathId: path.id,
              sourceId: sourceId ?? null,
              role: resource.role,
              resourceType: resource.resourceType,
              title: resource.title,
              url: resource.url,
            });
          }
        }
        await tx
          .update(learningPaths)
          .set({ status: 'READING', errorCode: null, errorMessage: null })
          .where(eq(learningPaths.id, path.id));
        return true;
      });
      return saved ? listResources(ref) : undefined;
    },

    /**
     * Puts the path's `FAILED` sources back to `PENDING` so a retried path reads them again;
     * `READY` ones are reused as they are.
     */
    async resetFailedSources(ref: PathRef): Promise<void> {
      const ids = (await listResources(ref)).flatMap((r) =>
        r.sourceId && r.sourceStatus === 'FAILED' ? [r.sourceId] : [],
      );
      if (ids.length === 0) return;
      await db
        .update(sources)
        .set({ status: 'PENDING', errorCode: null, errorMessage: null, processingRunId: null })
        .where(
          and(
            inArray(sources.id, ids),
            eq(sources.userId, ref.userId),
            eq(sources.status, 'FAILED'),
          ),
        );
    },
  };
}

export type LearningPathsRepository = ReturnType<typeof createLearningPathsRepository>;
