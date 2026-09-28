import { eq } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema/index.js';
import { createTestAuthProvider } from '../../src/lib/auth/test-auth.js';
import { getUserId, requireAuth } from '../../src/middleware/auth.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { createUsersRepository } from '../../src/repositories/users.repository.js';
import { createUsersService } from '../../src/services/users.service.js';
import { bearer, createTestApp } from '../helpers/app.js';
import { getTestDb } from '../helpers/db.js';

/** A tiny app with one protected route that echoes the resolved user ID. */
function protectedApp() {
  const db = getTestDb();
  const app = express();
  app.use(requireAuth(createTestAuthProvider(), createUsersService(createUsersRepository(db))));
  app.get('/whoami', (req, res) => {
    res.json({ userId: getUserId(req) });
  });
  app.use(errorHandler);
  return app;
}

async function userRows(clerkUserId: string) {
  return getTestDb().select().from(users).where(eq(users.clerkUserId, clerkUserId));
}

describe('auth', () => {
  it('no token → 401 in the standard format', async () => {
    const res = await request(createTestApp()).get('/api/v1/notebooks');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
    });
  });

  it('bad token → 401', async () => {
    const res = await request(createTestApp())
      .get('/api/v1/notebooks')
      .set('authorization', 'Bearer not-a-valid-token');

    expect(res.status).toBe(401);
  });

  it('/health stays public', async () => {
    const res = await request(createTestApp()).get('/health');

    expect(res.status).toBe(200);
  });

  it('first request from a new user creates the user row, later requests reuse it', async () => {
    const app = protectedApp();

    const first = await request(app).get('/whoami').set('authorization', bearer('user_first'));
    const second = await request(app).get('/whoami').set('authorization', bearer('user_first'));

    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const rows = await userRows('user_first');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe((first.body as { userId: string }).userId);
  });

  it('two parallel first requests → still one row', async () => {
    const app = protectedApp();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).get('/whoami').set('authorization', bearer('user_parallel')),
      ),
    );

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const ids = new Set(responses.map((r) => (r.body as { userId: string }).userId));
    expect(ids.size).toBe(1);
    expect(await userRows('user_parallel')).toHaveLength(1);
  });

  it('test auth provider refuses to load outside NODE_ENV=test', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createTestAuthProvider()).toThrow('NODE_ENV=test');
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
