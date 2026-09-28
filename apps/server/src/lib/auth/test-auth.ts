import type { AuthProvider } from './types.js';

export const TEST_TOKEN_PREFIX = 'test_';

/** Test tokens: `Bearer test_<clerkUserId>`. Never loads outside the test environment. */
export function createTestAuthProvider(): AuthProvider {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Test auth provider can only be used when NODE_ENV=test');
  }
  return {
    middleware: (_req, _res, next) => {
      next();
    },
    getClerkUserId(req) {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      if (!token.startsWith(TEST_TOKEN_PREFIX)) return null;
      const clerkUserId = token.slice(TEST_TOKEN_PREFIX.length);
      return clerkUserId.length > 0 ? clerkUserId : null;
    },
  };
}
