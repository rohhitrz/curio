import type { z } from 'zod';
import { ApiError, toApiError } from './errors';

export const API_PREFIX = '/api/v1';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns the session token to send as `Authorization: Bearer …` (Clerk, from Phase 1). */
  getToken: () => Promise<string | null>;
  fetch?: typeof fetch;
}

interface RequestOptions<T> {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Validates the response body when given. */
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
}

export function createApiClient({ baseUrl, getToken, fetch: fetchImpl = fetch }: ApiClientOptions) {
  /** Sends the request; a failed fetch (offline, DNS) becomes a `SERVICE_UNAVAILABLE` ApiError. */
  async function send(
    method: Method,
    path: string,
    options: RequestOptions<unknown>,
    accept: string,
  ) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers = new Headers({ accept });
    const token = await getToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    try {
      return await fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? null : JSON.stringify(options.body),
        signal: options.signal ?? null,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(
        0,
        'SERVICE_UNAVAILABLE',
        'Could not reach the server. Check your connection.',
      );
    }
  }

  async function request<T>(method: Method, path: string, options: RequestOptions<T> = {}) {
    const res = await send(method, path, options, 'application/json');
    if (res.status === 204) return undefined as T;

    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw toApiError(res.status, body);
    return options.schema ? options.schema.parse(body) : (body as T);
  }

  const api = (path: string) => `${API_PREFIX}${path}`;

  return {
    get: <T>(path: string, options?: RequestOptions<T>) => request<T>('GET', api(path), options),
    post: <T>(path: string, body?: unknown, options?: RequestOptions<T>) =>
      request<T>('POST', api(path), { ...options, body }),
    patch: <T>(path: string, body?: unknown, options?: RequestOptions<T>) =>
      request<T>('PATCH', api(path), { ...options, body }),
    put: <T>(path: string, body?: unknown, options?: RequestOptions<T>) =>
      request<T>('PUT', api(path), { ...options, body }),
    delete: <T = void>(path: string, options?: RequestOptions<T>) =>
      request<T>('DELETE', api(path), options),
    /**
     * POST that answers with a stream (chat). Errors before the stream starts come back as the
     * usual JSON and are thrown as `ApiError`; otherwise the open response is returned.
     */
    stream: async (path: string, body?: unknown, options: { signal?: AbortSignal } = {}) => {
      const res = await send('POST', api(path), { ...options, body }, 'text/event-stream');
      if (!res.ok) throw toApiError(res.status, await res.json().catch(() => undefined));
      if (!res.body) throw new ApiError(res.status, 'INTERNAL_ERROR', 'The answer was empty.');
      return res.body;
    },
    /** `GET /health` sits outside `/api/v1`. */
    health: () => request<{ status: string }>('GET', '/health'),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
