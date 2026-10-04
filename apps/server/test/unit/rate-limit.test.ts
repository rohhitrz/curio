import type { Redis } from '@upstash/redis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpstashRateLimiter } from '../../src/lib/rate-limit/index.js';
import { formatWait } from '../../src/middleware/rate-limit.js';

/** `limit()` results per limiter prefix, in call order. */
const calls: string[] = [];
let results: Record<string, { success: boolean; reset: number }>;

vi.mock('@upstash/ratelimit', () => {
  class Ratelimit {
    static slidingWindow = vi.fn(() => ({}));
    constructor(private readonly options: { prefix: string }) {}
    limit(identifier: string) {
      calls.push(`${this.options.prefix}|${identifier}`);
      return Promise.resolve(results[this.options.prefix] ?? { success: true, reset: 0 });
    }
  }
  return { Ratelimit };
});

const redis = {} as Redis;
const minute = { limit: 20, windowSeconds: 60 };
const day = { limit: 200, windowSeconds: 86_400 };

beforeEach(() => {
  calls.length = 0;
  results = {};
});

describe('Upstash rate limiter', () => {
  it('checks the shortest window first and counts every rule when allowed', async () => {
    const limiter = createUpstashRateLimiter(redis, 'rl');

    expect(await limiter.check('chat', 'u1', [day, minute])).toEqual({ allowed: true });
    expect(calls).toEqual(['rl:chat:20/60s|u1', 'rl:chat:200/86400s|u1']);
  });

  it('a denied short window stops before the longer one is counted', async () => {
    results['rl:chat:20/60s'] = { success: false, reset: Date.now() + 42_000 };
    const limiter = createUpstashRateLimiter(redis, 'rl');

    const result = await limiter.check('chat', 'u1', [minute, day]);

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 42 });
    expect(calls).toEqual(['rl:chat:20/60s|u1']);
  });

  it('a denied daily window → its reset time, at least 1 second', async () => {
    results['rl:chat:200/86400s'] = { success: false, reset: Date.now() - 5 };
    const limiter = createUpstashRateLimiter(redis, 'rl');

    expect(await limiter.check('chat', 'u1', [minute, day])).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });
});

describe('formatWait', () => {
  it.each([
    [1, '1 second'],
    [42, '42 seconds'],
    [60, '1 minute'],
    [61, '2 minutes'],
    [3599, '60 minutes'],
    [3600, 'about 1 hour'],
    [5 * 3600 + 100, 'about 5 hours'],
    [86_400, 'about 24 hours'],
  ])('%i → %s', (seconds, text) => {
    expect(formatWait(seconds)).toBe(text);
  });
});
