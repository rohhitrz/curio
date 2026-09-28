import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { notebooks, sources, users } from '../../src/db/schema/index.js';
import { getTestDb } from '../helpers/db.js';

describe('test database', () => {
  it('connects to the Neon test branch with pgvector enabled', async () => {
    const result = await getTestDb().execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'vector'`,
    );

    expect(result.rows).toEqual([{ extname: 'vector' }]);
  });
});

describe('schema', () => {
  it('deleting a user cascades to their notebooks', async () => {
    const db = getTestDb();
    const [user] = await db.insert(users).values({ clerkUserId: 'user_cascade' }).returning();
    if (!user) throw new Error('user not created');
    await db.insert(notebooks).values({ userId: user.id, title: 'Physics', kind: 'SOURCE' });

    await db.delete(users).where(eq(users.id, user.id));

    const left = await db.select().from(notebooks).where(eq(notebooks.userId, user.id));
    expect(left).toHaveLength(0);
  });

  it('rejects an unknown notebook kind', async () => {
    const db = getTestDb();
    const [user] = await db.insert(users).values({ clerkUserId: 'user_kind' }).returning();
    if (!user) throw new Error('user not created');

    await expect(
      db.execute(
        sql`insert into notebooks (user_id, title, kind) values (${user.id}, 'x', 'OTHER')`,
      ),
    ).rejects.toThrow();
  });

  describe('sources', () => {
    async function seedNotebook(clerkUserId: string) {
      const db = getTestDb();
      const [user] = await db.insert(users).values({ clerkUserId }).returning();
      if (!user) throw new Error('user not created');
      const [notebook] = await db
        .insert(notebooks)
        .values({ userId: user.id, title: 'Physics', kind: 'SOURCE' })
        .returning();
      if (!notebook) throw new Error('notebook not created');
      return { user, notebook };
    }

    it('defaults to USER origin, PENDING status, empty metadata', async () => {
      const { user, notebook } = await seedNotebook('user_src_defaults');

      const [source] = await getTestDb()
        .insert(sources)
        .values({
          notebookId: notebook.id,
          userId: user.id,
          type: 'TEXT',
          title: 'Notes',
          contentHash: 'hash-defaults',
        })
        .returning();

      expect(source).toMatchObject({
        origin: 'USER',
        status: 'PENDING',
        metadata: {},
        chunkCount: 0,
      });
    });

    it('rejects the same content hash twice in one notebook, allows it in another', async () => {
      const db = getTestDb();
      const { user, notebook } = await seedNotebook('user_src_dupe');
      const [other] = await db
        .insert(notebooks)
        .values({ userId: user.id, title: 'Chemistry', kind: 'SOURCE' })
        .returning();
      if (!other) throw new Error('notebook not created');
      const row = { userId: user.id, type: 'TEXT' as const, title: 'x', contentHash: 'same' };

      await db.insert(sources).values({ ...row, notebookId: notebook.id });

      await expect(
        db.insert(sources).values({ ...row, notebookId: notebook.id }),
      ).rejects.toThrow();
      await expect(
        db.insert(sources).values({ ...row, notebookId: other.id }),
      ).resolves.toBeDefined();
    });

    it('deleting a notebook cascades to its sources', async () => {
      const db = getTestDb();
      const { user, notebook } = await seedNotebook('user_src_cascade');
      await db.insert(sources).values({
        notebookId: notebook.id,
        userId: user.id,
        type: 'TEXT',
        title: 'x',
        contentHash: 'cascade',
      });

      await db.delete(notebooks).where(eq(notebooks.id, notebook.id));

      const left = await db.select().from(sources).where(eq(sources.notebookId, notebook.id));
      expect(left).toHaveLength(0);
    });
  });
});
