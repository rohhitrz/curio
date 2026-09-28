import { errorResponseSchema } from '@curio/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NotFoundError } from '../../src/errors/app-error.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { requestLogger } from '../../src/middleware/request-logger.js';
import { createTestApp, testLogger } from '../helpers/app.js';

function appWithRoute(handler: express.RequestHandler) {
  const app = express();
  app.use(requestLogger(testLogger));
  app.use(express.json());
  app.all('/boom', handler);
  app.use(errorHandler);
  return app;
}

describe('error format', () => {
  it('unknown route → 404 in the standard error format', async () => {
    const res = await request(createTestApp()).get('/does-not-exist');

    expect(res.status).toBe(404);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });

  it('thrown error in a handler → 500 in the standard format, no stack trace leaked', async () => {
    const app = appWithRoute(() => {
      throw new Error('secret internal detail');
    });

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
    });
    expect(res.text).not.toContain('secret internal detail');
    expect(res.text).not.toContain('at ');
  });

  it('rejected promise in an async handler → 500 (Express 5 catches it)', async () => {
    const app = appWithRoute(async () => {
      await Promise.resolve();
      throw new Error('async failure');
    });

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('INTERNAL_ERROR');
  });

  it('AppError → its own status and code', async () => {
    const app = appWithRoute(() => {
      throw new NotFoundError();
    });

    const res = await request(app).get('/boom');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });

  it('ZodError → 400 VALIDATION_ERROR with field details', async () => {
    const app = appWithRoute((req) => {
      z.object({ url: z.url() }).parse(req.body);
    });

    const res = await request(app).post('/boom').send({ url: 'nope' });

    expect(res.status).toBe(400);
    const body = errorResponseSchema.parse(res.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toHaveProperty('url');
  });

  it('malformed JSON body → 400 VALIDATION_ERROR', async () => {
    const app = appWithRoute(() => undefined);

    const res = await request(app)
      .post('/boom')
      .set('content-type', 'application/json')
      .send('{bad');

    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('VALIDATION_ERROR');
  });
});
