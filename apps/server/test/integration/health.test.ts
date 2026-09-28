import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';

describe('GET /health', () => {
  it('returns 200', async () => {
    const res = await request(createTestApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('sets a request ID, reusing the incoming one', async () => {
    const app = createTestApp();

    const generated = await request(app).get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const reused = await request(app).get('/health').set('x-request-id', 'abc-123');
    expect(reused.headers['x-request-id']).toBe('abc-123');
  });

  it('sends security headers', async () => {
    const res = await request(createTestApp()).get('/health');

    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
