import { randomUUID } from 'node:crypto';
import type {
  BranchOption,
  ConceptStatus,
  PathHook,
  PathStatus,
  ResourceRole,
  ResourceType,
} from '@curio/shared';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  conceptCoverage,
  concepts,
  learningPaths,
  modules,
  pathResources,
  sources,
} from '../db/schema/index.js';

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

/** The finished outline, written in one go (`saveOutline`). */
export interface OutlineToSave {
  modules: { title: string; summary: string }[];
  concepts: {
    name: string;
    description: string;
    consensusScore: number;
    status: ConceptStatus;
    skipReason: string | null;
    /** Index into `modules`; null for a skipped concept. */
    module: number | null;
    position: number | null;
    /** `path_resources.id`s. */
    resourceIds: string[];
  }[];
  hook: PathHook | null;
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
          selectedBranch: learningPaths.selectedBranch,
        })
        .from(learningPaths)
        .where(owned(ref))
        .limit(1);
      return row;
    },

    /** The resources that were read (`READY` source), official first: what the map step reads. */
    async readResources(ref: PathRef) {
      const rows = await listResources(ref);
      return rows.flatMap((r) =>
        r.sourceStatus === 'READY' ? [{ resourceId: r.id, role: r.role, title: r.title }] : [],
      );
    },

    /** The opening of a resource's extracted text (cut in SQL: a docs site can be long). */
    async resourceText(ref: PathRef, resourceId: string, maxChars: number) {
      const [row] = await db
        .select({
          title: pathResources.title,
          text: sql<string>`left(coalesce(${sources.extractedText}, ''), ${maxChars})`,
        })
        .from(pathResources)
        .innerJoin(learningPaths, eq(learningPaths.id, pathResources.pathId))
        .innerJoin(sources, eq(sources.id, pathResources.sourceId))
        .where(and(owned(ref), eq(pathResources.id, resourceId), eq(sources.userId, ref.userId)))
        .limit(1);
      return row;
    },

    /** Advanced path: the branches to pick from; `MAPPING` → `AWAITING_BRANCH`. */
    async offerBranches(ref: PathRef, options: BranchOption[]): Promise<boolean> {
      const rows = await db
        .update(learningPaths)
        .set({ status: 'AWAITING_BRANCH', branchOptions: options, selectedBranch: null })
        .where(and(owned(ref), eq(learningPaths.status, 'MAPPING')))
        .returning({ id: learningPaths.id });
      return rows.length > 0;
    },

    /**
     * Writes the outline and makes the path `READY`, in one transaction: modules, concepts (kept
     * ones placed in a module, skipped ones with their reason), coverage and the hook. Anything
     * from an earlier attempt is replaced. A path already `READY` (the step ran twice) is left
     * as it is. `not_found` when the path is gone or in another status.
     */
    async saveOutline(
      ref: PathRef,
      outline: OutlineToSave,
    ): Promise<'saved' | 'already_ready' | 'not_found'> {
      return db.transaction(async (tx) => {
        const [path] = await tx
          .select({ id: learningPaths.id, status: learningPaths.status })
          .from(learningPaths)
          .where(owned(ref))
          .for('update');
        if (path?.status === 'READY') return 'already_ready';
        if (path?.status !== 'BUILDING') return 'not_found';

        await tx.delete(concepts).where(eq(concepts.pathId, path.id));
        await tx.delete(modules).where(eq(modules.pathId, path.id));
        const moduleIds =
          outline.modules.length === 0
            ? []
            : (
                await tx
                  .insert(modules)
                  .values(
                    outline.modules.map((m, i) => ({
                      pathId: path.id,
                      position: i + 1,
                      title: m.title,
                      summary: m.summary,
                    })),
                  )
                  .returning({ id: modules.id, position: modules.position })
              )
                .sort((a, b) => a.position - b.position)
                .map((m) => m.id);

        // IDs made here, so coverage rows can point at them without relying on RETURNING order.
        const rows = outline.concepts.map((c) => ({ id: randomUUID(), concept: c }));
        if (rows.length > 0) {
          await tx.insert(concepts).values(
            rows.map(({ id, concept: c }) => ({
              id,
              pathId: path.id,
              name: c.name,
              description: c.description,
              consensusScore: c.consensusScore,
              status: c.status,
              skipReason: c.skipReason,
              moduleId: c.module === null ? null : (moduleIds[c.module] ?? null),
              position: c.position,
            })),
          );
          const coverage = rows.flatMap(({ id, concept }) =>
            concept.resourceIds.map((pathResourceId) => ({ conceptId: id, pathResourceId })),
          );
          if (coverage.length > 0) {
            await tx.insert(conceptCoverage).values(coverage).onConflictDoNothing();
          }
        }

        await tx
          .update(learningPaths)
          .set({ status: 'READY', hook: outline.hook, errorCode: null, errorMessage: null })
          .where(eq(learningPaths.id, path.id));
        return 'saved';
      });
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
