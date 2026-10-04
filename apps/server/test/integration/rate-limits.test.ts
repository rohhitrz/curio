import { randomUUID } from 'node:crypto';
import { errorResponseSchema } from '@curio/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { rateLimits } from '../../src/config/index.js';
import { users } from '../../src/db/schema/index.js';
import { createFakeRateLimiter, type FakeRateLimiter } from '../fakes/rate-limit.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const ALICE = bearer('user_alice');
const BOB = bearer('user_bob');
const DAY = 24 * 60 * 60;

let limiter: FakeRateLimiter;
let app: ReturnType<typeof createTestApp>;

type LimitName = keyof typeof rateLimits;

/**
 * Every limited endpoint (docs/04-api-design.md §10). The limit runs before the controller, so
 * made-up IDs are enough: under the limit the request goes through (404 / 400), over it → 429.
 */
interface LimitedEndpoint {
  route: string;
  name: LimitName;
  call: (auth: string) => request.Test;
}

const [chat, chatRetry, ...others]: LimitedEndpoint[] = [
  {
    route: 'POST /conversations/:id/messages',
    name: 'chatMessages',
    call: (auth) =>
      request(app)
        .post(`/api/v1/conversations/${randomUUID()}/messages`)
        .set('authorization', auth)
        .send({ content: 'Q?' }),
  },
  {
    route: 'POST /conversations/:id/retry',
    name: 'chatMessages',
    call: (auth) =>
      request(app).post(`/api/v1/conversations/${randomUUID()}/retry`).set('authorization', auth),
  },
  {
    route: 'POST /modules/:id/lessons',
    name: 'lessonGenerations',
    call: (auth) =>
      request(app).post(`/api/v1/modules/${randomUUID()}/lessons`).set('authorization', auth),
  },
  {
    route: 'POST /learning-paths',
    name: 'learningPaths',
    call: (auth) => request(app).post('/api/v1/learning-paths').set('authorization', auth).send({}),
  },
  {
    route: 'GET /learning-paths/scope',
    name: 'pathScopeChecks',
    call: (auth) => request(app).get('/api/v1/learning-paths/scope').set('authorization', auth),
  },
  {
    route: 'POST /notebooks/:id/sources',
    name: 'sourceAdds',
    call: (auth) =>
      request(app)
        .post(`/api/v1/notebooks/${randomUUID()}/sources`)
        .set('authorization', auth)
        .send({}),
  },
];
if (!chat || !chatRetry) throw new Error('chat endpoints missing');
const endpoints = [chat, chatRetry, ...others];

/** Our internal user ID (created on the first request). */
async function userIdOf(auth: string, clerkUserId: string): Promise<string> {
  await request(app).get('/api/v1/notebooks').set('authorization', auth).expect(200);
  const [user] = await getTestDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId));
  if (!user) throw new Error(`no user ${clerkUserId}`);
  return user.id;
}

/** The longest window: the daily one for every limit. */
function dailyRule(name: LimitName) {
  const rules = rateLimits[name];
  return rules.reduce((a, b) => (b.windowSeconds > a.windowSeconds ? b : a), rules[0]);
}

beforeEach(async () => {
  await truncateAllTables();
  limiter = createFakeRateLimiter();
  limiter.enforce();
  app = createTestApp({ rateLimiter: limiter });
});

describe('rate limits on every limited endpoint', () => {
  it.each(endpoints)(
    '$route: the last allowed request goes through, the next → 429 + Retry-After',
    async ({ name, call }) => {
      const alice = await userIdOf(ALICE, 'user_alice');
      const rule = dailyRule(name);
      expect(rule.windowSeconds).toBe(DAY);
      limiter.setUsed(name, alice, rule.windowSeconds, rule.limit - 1);

      // Reached the controller: the made-up ID / empty body is refused there.
      const last = await call(ALICE);
      expect([400, 404]).toContain(last.status);

      const over = await call(ALICE);
      expect(over.status).toBe(429);
      expect(errorResponseSchema.parse(over.body).error.code).toBe('RATE_LIMITED');
      expect(over.headers['retry-after']).toBe(String(DAY));
      expect(errorResponseSchema.parse(over.body).error.message).toBe(
        'Too many requests. Try again in about 24 hours.',
      );
    },
  );

  it.each(endpoints)('$route: limits are per user', async ({ name, call }) => {
    const alice = await userIdOf(ALICE, 'user_alice');
    const rule = dailyRule(name);
    limiter.setUsed(name, alice, rule.windowSeconds, rule.limit);

    expect((await call(ALICE)).status).toBe(429);
    expect([400, 404]).toContain((await call(BOB)).status);
  });

  it('the rule set covers exactly the 5 limited endpoints', () => {
    expect(Object.keys(rateLimits).sort()).toEqual(
      [...new Set(endpoints.map((e) => e.name))].sort(),
    );
  });
});

describe('chat: per minute and per day', () => {
  it('the 21st message in a minute → 429 with the minute wait; the daily count is untouched', async () => {
    const alice = await userIdOf(ALICE, 'user_alice');

    for (let i = 0; i < 20; i++) expect((await chat.call(ALICE)).status).not.toBe(429);
    const over = await chat.call(ALICE);

    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBe('60');
    expect(errorResponseSchema.parse(over.body).error.message).toBe(
      'Too many requests. Try again in 1 minute.',
    );
    // Retrying after a per-minute 429 doesn't use the day's allowance.
    expect(limiter.used('chatMessages', alice, DAY)).toBe(20);
  });

  it('send and retry share one count', async () => {
    const alice = await userIdOf(ALICE, 'user_alice');
    limiter.setUsed('chatMessages', alice, 60, 19);

    expect((await chatRetry.call(ALICE)).status).not.toBe(429);
    expect((await chat.call(ALICE)).status).toBe(429);
  });
});

describe('endpoints that are not limited', () => {
  it('a path retry, reads and the upload URL never check a limit', async () => {
    await userIdOf(ALICE, 'user_alice');
    limiter.checks.length = 0;

    await request(app)
      .post(`/api/v1/learning-paths/${randomUUID()}/retry`)
      .set('authorization', ALICE);
    await request(app).get('/api/v1/learning-paths/prefill').set('authorization', ALICE);
    await request(app)
      .post(`/api/v1/notebooks/${randomUUID()}/uploads`)
      .set('authorization', ALICE)
      .send({});
    await request(app).get(`/api/v1/modules/${randomUUID()}/lesson`).set('authorization', ALICE);

    expect(limiter.checks).toEqual([]);
  });
});

describe('without a signed-in user', () => {
  it.each(endpoints)('$route → 401 before any limit is checked', async ({ call }) => {
    const res = await call('');
    expect(res.status).toBe(401);
    expect(limiter.checks).toEqual([]);
  });
});
