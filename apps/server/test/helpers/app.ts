import { createApp } from '../../src/create-app.js';
import { createTestAuthProvider, TEST_TOKEN_PREFIX } from '../../src/lib/auth/test-auth.js';
import { createLogger } from '../../src/logger.js';
import { createFakeStorage, type FakeStorage } from '../fakes/storage.js';
import { getTestDb } from './db.js';

export const testLogger = createLogger({ level: 'silent', pretty: false });

export function createTestApp(storage: FakeStorage = createFakeStorage()) {
  return createApp({
    logger: testLogger,
    corsOrigins: ['http://localhost:3000'],
    db: getTestDb(),
    auth: createTestAuthProvider(),
    storage: storage.provider,
  });
}

/** `Authorization` header value for a test user. */
export function bearer(clerkUserId: string) {
  return `Bearer ${TEST_TOKEN_PREFIX}${clerkUserId}`;
}
