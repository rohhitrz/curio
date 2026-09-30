import type { RequestHandler } from 'express';
import { createApp } from '../../src/create-app.js';
import { createTestAuthProvider, TEST_TOKEN_PREFIX } from '../../src/lib/auth/test-auth.js';
import { createLogger } from '../../src/logger.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { createFakeStorage, type FakeStorage } from '../fakes/storage.js';
import { getTestDb } from './db.js';

export const testLogger = createLogger({ level: 'silent', pretty: false });

const noJobsEndpoint: RequestHandler = (_req, res) => {
  res.sendStatus(404);
};

export interface TestAppOptions {
  storage?: FakeStorage;
  jobs?: FakeJobs;
  jobsHandler?: RequestHandler;
}

export function createTestApp({
  storage = createFakeStorage(),
  jobs = createFakeJobs(),
  jobsHandler = noJobsEndpoint,
}: TestAppOptions = {}) {
  return createApp({
    logger: testLogger,
    corsOrigins: ['http://localhost:3000'],
    db: getTestDb(),
    auth: createTestAuthProvider(),
    storage: storage.provider,
    jobs: jobs.provider,
    jobsHandler,
  });
}

/** `Authorization` header value for a test user. */
export function bearer(clerkUserId: string) {
  return `Bearer ${TEST_TOKEN_PREFIX}${clerkUserId}`;
}
