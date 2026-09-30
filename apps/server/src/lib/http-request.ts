import { IngestionError } from '../errors/ingestion-error.js';

/**
 * The parts of a fetch `Response` the providers use. Declared here because Vercel's build
 * type-checks each file on its own, where the global `Response` type comes out empty.
 */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface RequestOptions {
  fetch: typeof fetch;
  timeoutMs: number;
  /** User-facing message when the service can't be reached or takes too long. */
  unreachableMessage: string;
}

/**
 * `fetch` with a timeout. A network failure or a timeout becomes a transient `IngestionError`;
 * HTTP error statuses are returned for the caller to classify.
 */
export async function request(
  url: string | URL,
  init: RequestInit,
  { fetch, timeoutMs, unreachableMessage }: RequestOptions,
): Promise<HttpResponse> {
  try {
    const response: unknown = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response as HttpResponse;
  } catch (cause) {
    throw IngestionError.transient(unreachableMessage, { cause });
  }
}

/** The JSON body, or `null` when the body is empty or not JSON (e.g. a gateway's HTML error page). */
export async function readJson(response: HttpResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
