import type { RequestHandler } from 'express';

/** Verifies the request's bearer token. */
export interface AuthProvider {
  /** Runs before `getClerkUserId` (e.g. to parse and verify the token). */
  middleware: RequestHandler;
  /** The verified Clerk user ID, or null when the token is missing or invalid. */
  getClerkUserId(req: Parameters<RequestHandler>[0]): string | null;
}
