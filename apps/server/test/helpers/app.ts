import type { RequestHandler } from 'express';
import type { RetrievalFlags } from '../../src/config/index.js';
import { createApp } from '../../src/create-app.js';
import { createTestAuthProvider, TEST_TOKEN_PREFIX } from '../../src/lib/auth/test-auth.js';
import { createLogger } from '../../src/logger.js';
import { createFakeEmbeddings, type FakeEmbeddings } from '../fakes/embeddings.js';
import { createFakeJobs, type FakeJobs } from '../fakes/jobs.js';
import { createFakeLlm, type FakeLlm } from '../fakes/llm.js';
import { createFakeLocks, type FakeLocks } from '../fakes/locks.js';
import { createFakeRateLimiter, type FakeRateLimiter } from '../fakes/rate-limit.js';
import { createFakeStorage, type FakeStorage } from '../fakes/storage.js';
import { createFakeTracer, type FakeTracer } from '../fakes/tracing.js';
import { getTestDb } from './db.js';

const allFlagsOff: RetrievalFlags = {
  queryRewrite: false,
  hybridSearch: false,
  rerank: false,
  subQueries: false,
  hyde: false,
};

export const testLogger = createLogger({ level: 'silent', pretty: false });

const noJobsEndpoint: RequestHandler = (_req, res) => {
  res.sendStatus(404);
};

export interface TestAppOptions {
  storage?: FakeStorage;
  jobs?: FakeJobs;
  embeddings?: FakeEmbeddings;
  llm?: FakeLlm;
  tracer?: FakeTracer;
  locks?: FakeLocks;
  rateLimiter?: FakeRateLimiter;
  jobsHandler?: RequestHandler;
  /** Defaults to every flag off: tests opt in, so the app's flags don't change other tests. */
  flags?: Partial<RetrievalFlags>;
}

export function createTestApp({
  storage = createFakeStorage(),
  jobs = createFakeJobs(),
  embeddings = createFakeEmbeddings(),
  llm = createFakeLlm(),
  tracer = createFakeTracer(),
  locks = createFakeLocks(),
  rateLimiter = createFakeRateLimiter(),
  jobsHandler = noJobsEndpoint,
  flags,
}: TestAppOptions = {}) {
  return createApp({
    logger: testLogger,
    corsOrigins: ['http://localhost:3000'],
    db: getTestDb(),
    auth: createTestAuthProvider(),
    storage: storage.provider,
    jobs: jobs.provider,
    embeddings: embeddings.provider,
    llm: llm.provider,
    tracer: tracer.tracer,
    locks: locks.provider,
    rateLimiter: rateLimiter.limiter,
    jobsHandler,
    flags: { ...allFlagsOff, ...flags },
  });
}

/** `Authorization` header value for a test user. */
export function bearer(clerkUserId: string) {
  return `Bearer ${TEST_TOKEN_PREFIX}${clerkUserId}`;
}
