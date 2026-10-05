import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createInngestClient, createInngestHandler } from '../../src/lib/jobs/index.js';
import { createTestApp, testLogger } from '../helpers/app.js';

const SIGNING_KEY = `signkey-test-${'ab'.repeat(32)}`;

/** The real Inngest handler with made-up keys and no network: any outgoing call is recorded and fails. */
function createInngestApp(isDev: boolean, serveOrigin?: string) {
  const outgoing: string[] = [];
  const bodies: string[] = [];
  const client = createInngestClient({
    isDev,
    eventKey: 'test-event-key',
    signingKey: SIGNING_KEY,
    logger: testLogger,
    fetch: (input, init) => {
      outgoing.push(input instanceof Request ? input.url : String(input));
      if (typeof init?.body === 'string') bodies.push(init.body);
      return Promise.reject(new Error('network is blocked in tests'));
    },
  });
  return {
    app: createTestApp({ jobsHandler: createInngestHandler(client, [], serveOrigin) }),
    outgoing,
    bodies,
  };
}

const runRequest = { event: {}, events: [], steps: {}, ctx: {} };

describe('/api/inngest', () => {
  it('run request without a signature → 401', async () => {
    const { app, outgoing } = createInngestApp(false);

    const res = await request(app).post('/api/inngest?fnId=curio-process-source').send(runRequest);

    expect(res.status).toBe(401);
    expect(outgoing).toEqual([]);
  });

  it('run request with a forged signature → 401', async () => {
    const { app } = createInngestApp(false);

    const res = await request(app)
      .post('/api/inngest?fnId=curio-process-source')
      .set('x-inngest-signature', `t=${Math.floor(Date.now() / 1000)}&s=${'0'.repeat(64)}`)
      .send(runRequest);

    expect(res.status).toBe(401);
  });

  it('unsigned GET → 401, so the app config is not exposed', async () => {
    const { app } = createInngestApp(false);

    const res = await request(app).get('/api/inngest');

    expect(res.status).toBe(401);
  });

  it('unsigned PUT (a sync) with a forged Host registers the pinned origin, not the Host', async () => {
    const { app, outgoing, bodies } = createInngestApp(false, 'https://api.curio.example');

    await request(app).put('/api/inngest').set('host', 'attacker.example');

    expect(outgoing.some((url) => url.includes('/fn/register'))).toBe(true);
    const registered = bodies.map((b) => (JSON.parse(b) as { url?: string }).url);
    expect(registered).toContain('https://api.curio.example/api/inngest');
    expect(bodies.join('')).not.toContain('attacker.example');
  });

  it('without the pin, a sync registers whatever Host the request carried (why it is set)', async () => {
    const { app, bodies } = createInngestApp(false);

    await request(app).put('/api/inngest').set('host', 'attacker.example');

    expect(bodies.join('')).toContain('attacker.example');
  });

  it('needs no user token: the handler answers, not the API auth', async () => {
    const { app } = createInngestApp(true);

    const res = await request(app).get('/api/inngest');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'dev', function_count: 0 });
  });

  it('a body over the general 1 MB limit is still parsed', async () => {
    const { app } = createInngestApp(false);

    const res = await request(app)
      .post('/api/inngest?fnId=curio-process-source')
      .send({ ...runRequest, steps: { big: 'x'.repeat(2 * 1024 * 1024) } });

    // Rejected for the missing signature, not as an unreadable body (400).
    expect(res.status).toBe(401);
  });
});
