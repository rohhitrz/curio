import type { RateLimiter } from '../../src/lib/rate-limit/index.js';

/**
 * Allows everything unless told to deny; records every check. After `enforce()` it counts like
 * the real limiter: per name + user, against each rule's limit (windows never pass), shortest
 * window first, a denied check not counted.
 */
export function createFakeRateLimiter() {
  const checks: { name: string; identifier: string }[] = [];
  let deny: { retryAfterSeconds: number } | null = null;
  let failNext: Error | null = null;
  let enforcing = false;
  const counts = new Map<string, number>();
  const key = (name: string, identifier: string, windowSeconds: number) =>
    `${name}:${identifier}:${windowSeconds}`;

  const limiter: RateLimiter = {
    check(name, identifier, rules) {
      checks.push({ name, identifier });
      if (failNext) {
        const error = failNext;
        failNext = null;
        return Promise.reject(error);
      }
      if (deny) return Promise.resolve({ allowed: false, ...deny });
      if (!enforcing) return Promise.resolve({ allowed: true });
      const ordered = [...rules].sort((a, b) => a.windowSeconds - b.windowSeconds);
      for (const rule of ordered) {
        const k = key(name, identifier, rule.windowSeconds);
        const used = counts.get(k) ?? 0;
        if (used >= rule.limit) {
          return Promise.resolve({ allowed: false, retryAfterSeconds: rule.windowSeconds });
        }
        counts.set(k, used + 1);
      }
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
    /** Count checks against their rules from now on. */
    enforce() {
      enforcing = true;
    },
    /** Sets how many actions a user has already used in one rule's window. */
    setUsed(name: string, identifier: string, windowSeconds: number, used: number) {
      counts.set(key(name, identifier, windowSeconds), used);
    },
    used(name: string, identifier: string, windowSeconds: number): number {
      return counts.get(key(name, identifier, windowSeconds)) ?? 0;
    },
  };
}

export type FakeRateLimiter = ReturnType<typeof createFakeRateLimiter>;
