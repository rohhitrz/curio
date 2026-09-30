export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  /** Parsed JSON body, when there is one. */
  body: unknown;
}

type Reply = Response | Error;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * A `fetch` that never touches the network: it answers with the given replies in order (an
 * `Error` is thrown, like a network failure) and records every request.
 */
export function stubFetch(...replies: Reply[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...replies];

  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const reply = queue.shift();
    if (reply === undefined) return Promise.reject(new Error('stubFetch: no reply left'));
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };

  return { fetch, requests };
}

/** What `AbortSignal.timeout` makes `fetch` reject with. */
export function timeoutError(): Error {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}
