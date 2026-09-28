import { clerkMiddleware, getAuth } from '@clerk/express';
import type { AuthProvider } from './types.js';

export function createClerkAuthProvider(options: {
  secretKey: string;
  publishableKey: string;
  authorizedParties: string[];
}): AuthProvider {
  return {
    middleware: clerkMiddleware(options),
    getClerkUserId: (req) => getAuth(req).userId ?? null,
  };
}
