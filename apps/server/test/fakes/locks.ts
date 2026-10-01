import type { LockProvider } from '../../src/lib/locks/index.js';

/** In-memory locks with a controllable clock, so tests can make a lock expire. */
export function createFakeLocks() {
  const held = new Map<string, { token: number; expiresAt: number }>();
  let now = 0;
  let nextToken = 0;
  let failNext: Error | null = null;

  const provider: LockProvider = {
    acquire(key, ttlSeconds) {
      if (failNext) {
        const error = failNext;
        failNext = null;
        return Promise.reject(error);
      }
      const current = held.get(key);
      if (current && current.expiresAt > now) return Promise.resolve(null);
      const token = ++nextToken;
      held.set(key, { token, expiresAt: now + ttlSeconds * 1000 });
      return Promise.resolve({
        release() {
          if (held.get(key)?.token === token) held.delete(key);
          return Promise.resolve();
        },
      });
    },
  };

  return {
    provider,
    /** Moves the clock forward (lock expiry). */
    advance(ms: number) {
      now += ms;
    },
    isHeld: (key: string) => {
      const current = held.get(key);
      return current !== undefined && current.expiresAt > now;
    },
    /** Takes a lock as another holder would (e.g. a request still generating). */
    hold: (key: string, ttlSeconds: number) => provider.acquire(key, ttlSeconds),
    failNextAcquire(error: Error) {
      failNext = error;
    },
  };
}

export type FakeLocks = ReturnType<typeof createFakeLocks>;
