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
      const results = await Promise.all(
        rules.map((rule) => limiterFor(name, rule).limit(identifier)),
      );
      const denied = results.filter((result) => !result.success);
      if (denied.length === 0) return { allowed: true };
      // Wait for the window that frees up last.
      const reset = Math.max(...denied.map((result) => result.reset));
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((reset - Date.now()) / 1000)),
      };
    },
  };
}
