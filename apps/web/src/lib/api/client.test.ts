import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { ApiError } from './errors';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(response: Response | Error, token: string | null = 'tok_123') {
  const fetchMock = vi.fn<typeof fetch>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  const api = createApiClient({
    baseUrl: 'http://api.test',
    getToken: () => Promise.resolve(token),
    fetch: fetchMock,
  });
  const call = () => {
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    return { url: (url as URL).href, init: init ?? {}, headers: new Headers(init?.headers) };
  };
  return { api, call };
}

describe('api client', () => {
  it('prefixes /api/v1, adds the bearer token, and sends JSON', async () => {
    const { api, call } = setup(jsonResponse(201, { id: 'n1' }));

    const result = await api.post('/notebooks', { title: 'Physics' });

    expect(result).toEqual({ id: 'n1' });
    expect(call().url).toBe('http://api.test/api/v1/notebooks');
    expect(call().init.method).toBe('POST');
    expect(call().init.body).toBe('{"title":"Physics"}');
    expect(call().headers.get('authorization')).toBe('Bearer tok_123');
    expect(call().headers.get('content-type')).toBe('application/json');
  });

  it('omits Authorization when there is no token', async () => {
    const { api, call } = setup(jsonResponse(200, { status: 'ok' }), null);

    await api.health();

    expect(call().url).toBe('http://api.test/health');
    expect(call().headers.has('authorization')).toBe(false);
  });

  it('serializes query params and skips undefined', async () => {
    const { api, call } = setup(jsonResponse(200, { items: [], nextCursor: null }));

    await api.get('/notebooks', { query: { limit: 20, cursor: undefined } });

    expect(call().url).toBe('http://api.test/api/v1/notebooks?limit=20');
  });

  it('parses the standard error format into ApiError', async () => {
    const { api } = setup(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some fields are invalid.',
          details: { url: 'Must be a valid URL' },
        },
      }),
    );

    const error = await api.post('/sources', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Some fields are invalid.',
      details: { url: 'Must be a valid URL' },
    });
  });

  it('falls back to INTERNAL_ERROR when the error body is not standard', async () => {
    const { api } = setup(new Response('<html>Bad gateway</html>', { status: 502 }));

    await expect(api.get('/notebooks')).rejects.toMatchObject({
      status: 502,
      code: 'INTERNAL_ERROR',
    });
  });

  it('maps network failures to SERVICE_UNAVAILABLE', async () => {
    const { api } = setup(new TypeError('fetch failed'));

    await expect(api.get('/notebooks')).rejects.toMatchObject({
      status: 0,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns undefined for 204', async () => {
    const { api } = setup(new Response(null, { status: 204 }));

    await expect(api.delete('/notebooks/n1')).resolves.toBeUndefined();
  });

  it('validates the response with a schema when given', async () => {
    const { z } = await import('zod');
    const { api } = setup(jsonResponse(200, { id: 42 }));

    await expect(
      api.get('/notebooks/n1', { schema: z.object({ id: z.string() }) }),
    ).rejects.toThrow();
  });
});
