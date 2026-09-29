/** One query cache per signed-in user; see `useQueryClientForUser` in `app/providers.tsx`. */
export interface UserCache<C> {
  /** `undefined` until Clerk says who is signed in (`null` = signed out). */
  userId: string | null | undefined;
  client: C;
  /** Bumped on every user change; keys the provider so every query remounts on the new client. */
  generation: number;
}

/**
 * The cache to use for `userId`, or the same object when nothing changes. Clerk resolving the
 * user for the first time isn't a change (the cache is kept); any later change gets a fresh
 * client, so one user never sees another's cached data.
 */
export function nextUserCache<C>(
  cache: UserCache<C>,
  userId: string | null | undefined,
  makeClient: () => C,
): UserCache<C> {
  if (userId === undefined || userId === cache.userId) return cache;
  if (cache.userId === undefined) return { ...cache, userId };
  return { userId, client: makeClient(), generation: cache.generation + 1 };
}
