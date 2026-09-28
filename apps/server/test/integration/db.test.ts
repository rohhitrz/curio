import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { notebooks, users } from '../../src/db/schema/index.js';
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
});
