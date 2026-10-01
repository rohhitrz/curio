import type { RateLimiter } from '../../src/lib/rate-limit/index.js';

/** Allows everything unless told to deny; records every check. */
export function createFakeRateLimiter() {
  const checks: { name: string; identifier: string }[] = [];
  let deny: { retryAfterSeconds: number } | null = null;
  let failNext: Error | null = null;

  const limiter: RateLimiter = {
    check(name, identifier) {
      checks.push({ name, identifier });
      if (failNext) {
        const error = failNext;
        failNext = null;
        return Promise.reject(error);
      }
      if (deny) return Promise.resolve({ allowed: false, ...deny });
      return Promise.resolve({ allowed: true });
    },
  };

  return {
    limiter,
    checks,
    /** Every check is denied from now on. */
    denyAll(retryAfterSeconds = 30) {
      deny = { retryAfterSeconds };
    },
    failNextCheck(error: Error) {
      failNext = error;
    },
  };
}

export type FakeRateLimiter = ReturnType<typeof createFakeRateLimiter>;
