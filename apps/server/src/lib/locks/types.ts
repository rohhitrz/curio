export interface Lock {
  /** Frees the lock if this holder still owns it (it may have expired and been taken since). */
  release(): Promise<void>;
  /**
   * Resets the expiry to `ttlSeconds` from now, if this holder still owns the lock. False → it
   * expired (and may have been taken since).
   */
  extend(ttlSeconds: number): Promise<boolean>;
}

/**
 * Short-lived exclusive locks shared across serverless instances (docs/04-api-design.md §10).
 * Every lock expires on its own, so a crashed holder never blocks forever.
 */
export interface LockProvider {
  /** The lock, or null when someone else holds it. */
  acquire(key: string, ttlSeconds: number): Promise<Lock | null>;
}
