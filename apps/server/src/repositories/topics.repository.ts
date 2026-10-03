import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { topics } from '../db/schema/index.js';

const columns = { id: topics.id, name: topics.name };

export type TopicRow = { id: string; name: string };

/** `topics` is shared across users (names aren't personal), so these queries take no user ID. */
export function createTopicsRepository(db: Db) {
  return {
    async findByNormalizedName(normalizedName: string): Promise<TopicRow | undefined> {
      const [row] = await db
        .select(columns)
        .from(topics)
        .where(eq(topics.normalizedName, normalizedName))
        .limit(1);
      return row;
    },

    /** With the name's embedding, for similarity lookups. */
    async findWithEmbedding(normalizedName: string) {
      const [row] = await db
        .select({ ...columns, embedding: topics.embedding })
        .from(topics)
        .where(eq(topics.normalizedName, normalizedName))
        .limit(1);
      return row;
    },

    /**
     * Inserts the topic, or returns the row someone else inserted first under the same
     * normalized name (the unique index settles a race; the first wording is kept).
     */
    async insertOrGet(topic: {
      name: string;
      normalizedName: string;
      embedding: number[];
    }): Promise<TopicRow> {
      const [inserted] = await db
        .insert(topics)
        .values(topic)
        .onConflictDoNothing({ target: topics.normalizedName })
        .returning(columns);
      if (inserted) return inserted;
      const existing = await this.findByNormalizedName(topic.normalizedName);
      if (!existing) throw new Error(`topic ${topic.normalizedName} conflicted but is missing`);
      return existing;
    },
  };
}

export type TopicsRepository = ReturnType<typeof createTopicsRepository>;
