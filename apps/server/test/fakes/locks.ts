import type { LockProvider } from '../../src/lib/locks/index.js';

/** In-memory locks with a controllable clock, so tests can make a lock expire. */
export function createFakeLocks() {
  const held = new Map<string, { token: number; expiresAt: number }>();
  let now = 0;
  let nextToken = 0;
  let failNext: Error | null = null;
  let extensions = 0;
  /** Release and renewal fail from now on (Redis gone mid-answer). */
  let heldCallsFail = false;

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
          if (heldCallsFail) return Promise.reject(new Error('fake locks: release failed'));
          if (held.get(key)?.token === token) held.delete(key);
          return Promise.resolve();
        },
        extend(ttl) {
          if (heldCallsFail) return Promise.reject(new Error('fake locks: extend failed'));
          const current = held.get(key);
          if (current?.token !== token || current.expiresAt <= now) return Promise.resolve(false);
          current.expiresAt = now + ttl * 1000;
          extensions += 1;
          return Promise.resolve(true);
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
    /** How many times a holder kept its lock alive. */
    extensions: () => extensions,
    failNextAcquire(error: Error) {
      failNext = error;
    },
    /** Every release and renewal of a held lock rejects from now on. */
    failHeldCalls() {
      heldCallsFail = true;
    },
  };
}

export type FakeLocks = ReturnType<typeof createFakeLocks>;
