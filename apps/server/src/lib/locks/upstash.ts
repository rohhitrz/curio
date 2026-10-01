import type { Redis } from '@upstash/redis';
import type { LockProvider } from './types.js';

/** Deletes the key only if it still holds our token, so we never free someone else's lock. */
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export function createUpstashLocks(redis: Redis, prefix = 'curio:lock:'): LockProvider {
  return {
    async acquire(key, ttlSeconds) {
      const fullKey = `${prefix}${key}`;
      const token = crypto.randomUUID();
      const result = await redis.set(fullKey, token, { nx: true, ex: ttlSeconds });
      if (result !== 'OK') return null;
      return {
        async release() {
          await redis.eval(RELEASE_SCRIPT, [fullKey], [token]);
        },
      };
    },
  };
}
