import { ExtractionError } from '../errors/extraction-error.js';

export interface RequestOptions {
  fetch: typeof fetch;
  timeoutMs: number;
  /** User-facing message when the service can't be reached or takes too long. */
  unreachableMessage: string;
}

/**
 * `fetch` with a timeout. A network failure or a timeout becomes a transient `ExtractionError`;
 * HTTP error statuses are returned for the caller to classify.
 */
export async function request(
  url: string | URL,
  init: RequestInit,
  { fetch, timeoutMs, unreachableMessage }: RequestOptions,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw ExtractionError.transient(unreachableMessage, { cause });
  }
}

/** The JSON body, or `null` when the body is empty or not JSON (e.g. a gateway's HTML error page). */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
