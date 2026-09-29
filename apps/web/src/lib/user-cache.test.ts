import { describe, expect, it } from 'vitest';
import { nextUserCache, type UserCache } from './user-cache';

let made = 0;
const makeClient = () => `client-${++made}`;
const cache = (userId: string | null | undefined, client = 'client-0', generation = 0) =>
  ({ userId, client, generation }) satisfies UserCache<string>;

describe('nextUserCache', () => {
  it('Clerk resolving the user for the first time keeps the client (no remount)', () => {
    const next = nextUserCache(cache(undefined), 'user_a', makeClient);
    expect(next).toEqual(cache('user_a'));
  });

  it('same user or Clerk still loading → same object', () => {
    const current = cache('user_a');
    expect(nextUserCache(current, 'user_a', makeClient)).toBe(current);
    expect(nextUserCache(current, undefined, makeClient)).toBe(current);
  });

  it.each([
    ['sign-out', 'user_a', null],
    ['account switch', 'user_a', 'user_b'],
    ['sign-in after being signed out', null, 'user_b'],
  ])('%s → fresh client and a new generation', (_label, from, to) => {
    const next = nextUserCache(cache(from, 'old', 3), to, makeClient);
    expect(next.userId).toBe(to);
    expect(next.client).not.toBe('old');
    expect(next.generation).toBe(4);
  });
});
