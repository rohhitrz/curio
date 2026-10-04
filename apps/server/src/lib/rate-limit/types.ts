export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Per-user sliding-window counters shared across serverless instances. */
export interface RateLimiter {
  /**
   * Counts one action under every rule; denied if any rule is over its limit. A denied action
   * isn't counted against the longer windows.
   */
  check(
    name: string,
    identifier: string,
    rules: readonly RateLimitRule[],
  ): Promise<RateLimitResult>;
}
