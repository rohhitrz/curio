import { Ratelimit } from '@upstash/ratelimit';
import type { Redis } from '@upstash/redis';
import type { RateLimiter, RateLimitRule } from './types.js';

export function createUpstashRateLimiter(redis: Redis, prefix = 'curio:rl'): RateLimiter {
  const limiters = new Map<string, Ratelimit>();

  function limiterFor(name: string, rule: RateLimitRule): Ratelimit {
    const key = `${prefix}:${name}:${rule.limit}/${rule.windowSeconds}s`;
    let limiter = limiters.get(key);
    if (!limiter) {
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(rule.limit, `${rule.windowSeconds} s`),
        prefix: key,
        analytics: false,
      });
      limiters.set(key, limiter);
    }
    return limiter;
  }

  return {
    async check(name, identifier, rules) {
      // Shortest window first, stopping at the first rule that's over: a denied request isn't
      // counted, so retrying after a per-minute 429 doesn't use up the daily allowance.
      const ordered = [...rules].sort((a, b) => a.windowSeconds - b.windowSeconds);
      for (const rule of ordered) {
        const result = await limiterFor(name, rule).limit(identifier);
        if (!result.success) {
          return {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
          };
        }
      }
      return { allowed: true };
    },
  };
}
