import { and, count, desc, eq, gt, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memories, topics, type Memory } from '../db/schema/index.js';

const columns = {
  id: memories.id,
  userId: memories.userId,
  scope: memories.scope,
  topicId: memories.topicId,
  topicName: topics.name,
  kind: memories.kind,
  content: memories.content,
  level: memories.level,
  conceptId: memories.conceptId,
  origin: memories.origin,
  originRef: memories.originRef,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
};

export type MemoryRow = NonNullable<Awaited<ReturnType<MemoriesRepository['findById']>>>;
type MemoryKind = Memory['kind'];
type MemoryOrigin = Memory['origin'];
type Level = NonNullable<Memory['level']>;

/** A memory to create. Scope follows `topicId` (the DB checks the pair). */
export interface NewMemory {
  topicId: string | null;
  kind: Exclude<MemoryKind, 'LEVEL'>;
  content: string;
  conceptId?: string | null;
  origin: MemoryOrigin;
  originRef?: string | null;
}

export interface MemoryFilters {
  scope?: Memory['scope'];
  topicId?: string;
  /** Created after this instant (the "Noted" notice polls with it). */
  since?: Date;
}

/** An open transaction. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Serializes a user's memory writes so count + insert can't overshoot the cap. */
async function lockUser(tx: Tx, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`memories:${userId}`}))`);
}

async function countFor(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(memories).where(eq(memories.userId, userId));
  return row?.n ?? 0;
}

/** Every query is scoped by `userId`; another user's memory reads as missing. */
export function createMemoriesRepository(db: Db) {
  async function findById(userId: string, memoryId: string) {
    const [row] = await db
      .select(columns)
      .from(memories)
      .leftJoin(topics, eq(topics.id, memories.topicId))
      .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)))
      .limit(1);
    return row;
  }

  /** Re-reads written rows with their topic name (a `RETURNING` can't join). */
  async function reread(userId: string, memoryId: string | undefined) {
    return memoryId === undefined ? undefined : findById(userId, memoryId);
  }

  return {
    findById,

    /** Newest first. Bounded by the per-user cap, so not paginated. */
    async list(userId: string, filters: MemoryFilters = {}) {
      return db
        .select(columns)
        .from(memories)
        .leftJoin(topics, eq(topics.id, memories.topicId))
        .where(
          and(
            eq(memories.userId, userId),
            filters.scope ? eq(memories.scope, filters.scope) : undefined,
            filters.topicId ? eq(memories.topicId, filters.topicId) : undefined,
            filters.since ? gt(memories.createdAt, filters.since) : undefined,
          ),
        )
        .orderBy(desc(memories.createdAt), desc(memories.id));
    },

    async count(userId: string): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(memories)
        .where(eq(memories.userId, userId));
      return row?.n ?? 0;
    },

    /** Creates the memory unless the user already has `max`. Undefined when the cap is reached. */
    async insertWithinCap(userId: string, memory: NewMemory, max: number) {
      const id = await db.transaction(async (tx) => {
        await lockUser(tx, userId);
        if ((await countFor(tx, userId)) >= max) return undefined;
        const [row] = await tx
          .insert(memories)
          .values({
            userId,
            scope: memory.topicId === null ? 'GLOBAL' : 'TOPIC',
            topicId: memory.topicId,
            kind: memory.kind,
            content: memory.content,
            conceptId: memory.conceptId ?? null,
            origin: memory.origin,
            originRef: memory.originRef ?? null,
          })
          .returning({ id: memories.id });
        return row?.id;
      });
      return reread(userId, id);
    },

    /**
     * The user's level for a topic: one row per topic (partial unique index), so a second level
     * updates it. A new row counts toward the cap; undefined when it's reached.
     */
    async upsertLevel(
      userId: string,
      level: {
        topicId: string;
        level: Level;
        content: string;
        origin: MemoryOrigin;
        originRef?: string | null;
      },
      max: number,
    ) {
      const id = await db.transaction(async (tx) => {
        await lockUser(tx, userId);
        const [existing] = await tx
          .select({ id: memories.id })
          .from(memories)
          .where(
            and(
              eq(memories.userId, userId),
              eq(memories.topicId, level.topicId),
              eq(memories.kind, 'LEVEL'),
            ),
          )
          .for('update');
        const values = {
          level: level.level,
          content: level.content,
          origin: level.origin,
          originRef: level.originRef ?? null,
        };
        if (existing) {
          await tx.update(memories).set(values).where(eq(memories.id, existing.id));
          return existing.id;
        }
        if ((await countFor(tx, userId)) >= max) return undefined;
        const [row] = await tx
          .insert(memories)
          .values({ userId, scope: 'TOPIC', topicId: level.topicId, kind: 'LEVEL', ...values })
          .returning({ id: memories.id });
        return row?.id;
      });
      return reread(userId, id);
    },

    /**
     * Updates content and/or level. `unlessUserEdited` (the extraction job) leaves a memory the
     * user edited untouched: undefined, as if it were missing.
     */
    async update(
      userId: string,
      memoryId: string,
      changes: { content?: string; level?: Level; origin?: MemoryOrigin },
      options: { unlessUserEdited?: boolean } = {},
    ) {
      const [row] = await db
        .update(memories)
        .set(changes)
        .where(
          and(
            eq(memories.id, memoryId),
            eq(memories.userId, userId),
            options.unlessUserEdited ? ne(memories.origin, 'USER_EDITED') : undefined,
          ),
        )
        .returning({ id: memories.id });
      return reread(userId, row?.id);
    },

    /** True if a row was deleted. */
    async delete(userId: string, memoryId: string): Promise<boolean> {
      const rows = await db
        .delete(memories)
        .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)))
        .returning({ id: memories.id });
      return rows.length > 0;
    },

    /** Deletes all of the user's memories; returns how many. */
    async deleteAll(userId: string): Promise<number> {
      const rows = await db
        .delete(memories)
        .where(eq(memories.userId, userId))
        .returning({ id: memories.id });
      return rows.length;
    },
  };
}

export type MemoriesRepository = ReturnType<typeof createMemoriesRepository>;
