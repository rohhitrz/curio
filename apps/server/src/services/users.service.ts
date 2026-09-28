import type { UsersRepository } from '../repositories/users.repository.js';

export function createUsersService(usersRepository: UsersRepository) {
  return {
    /**
     * Returns our user ID for a Clerk user, creating the row on first sight.
     * Safe under concurrent first requests: the unique constraint picks one winner.
     */
    async getOrCreateUserId(clerkUserId: string): Promise<string> {
      const existing = await usersRepository.findIdByClerkUserId(clerkUserId);
      if (existing) return existing;

      const created = await usersRepository.insertIfMissing(clerkUserId);
      if (created) return created;

      const raced = await usersRepository.findIdByClerkUserId(clerkUserId);
      if (!raced) throw new Error('User row missing after insert conflict');
      return raced;
    },
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
