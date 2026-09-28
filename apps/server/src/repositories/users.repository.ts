import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users } from '../db/schema/index.js';

export function createUsersRepository(db: Db) {
  return {
    async findIdByClerkUserId(clerkUserId: string): Promise<string | undefined> {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkUserId, clerkUserId))
        .limit(1);
      return row?.id;
    },

    /** Inserts the user unless it already exists; returns the new ID, or undefined on conflict. */
    async insertIfMissing(clerkUserId: string): Promise<string | undefined> {
      const [row] = await db
        .insert(users)
        .values({ clerkUserId })
        .onConflictDoNothing({ target: users.clerkUserId })
        .returning({ id: users.id });
      return row?.id;
    },
  };
}

export type UsersRepository = ReturnType<typeof createUsersRepository>;
