import type { RequestHandler } from 'express';
import { rateLimits } from '../config/index.js';
import { AppError } from '../errors/app-error.js';
import type { RateLimiter } from '../lib/rate-limit/index.js';
import { getUserId } from './auth.js';

export type RateLimitName = keyof typeof rateLimits;

/**
 * Per-user limit from `config/limits.ts` (docs/04-api-design.md §10). Over the limit → 429
 * `RATE_LIMITED` with `Retry-After`. If Redis can't be reached the request goes through: a limit
 * outage shouldn't take the feature down with it.
 */
export function rateLimit(limiter: RateLimiter, name: RateLimitName): RequestHandler {
  return async (req, res, next) => {
    const userId = getUserId(req);
    let result;
    try {
      result = await limiter.check(name, userId, rateLimits[name]);
    } catch (err) {
      req.log.warn({ err, limit: name }, 'rate limit check failed; request allowed');
      next();
      return;
    }
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfterSeconds));
      throw new AppError('RATE_LIMITED', 'Too many requests. Please wait a moment and try again.');
    }
    next();
  };
}
