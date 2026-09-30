import { describe, expect, it } from 'vitest';
import { IngestionError } from '../../src/errors/ingestion-error.js';
import { createOpenAiEmbeddings } from '../../src/lib/embeddings/index.js';
import { json, stubFetch, timeoutError } from '../helpers/fetch.js';

const DIMENSIONS = 4;

function embeddings(...replies: Parameters<typeof stubFetch>) {
  const stub = stubFetch(...replies);
  const provider = createOpenAiEmbeddings({
    apiKey: 'sk-test',
    model: 'text-embedding-3-small',
    dimensions: DIMENSIONS,
    batchSize: 2,
    timeoutMs: 30_000,
    fetch: stub.fetch,
  });
  return { provider, requests: stub.requests };
}

/** A vector whose first value identifies it. */
const vector = (id: number) => [id, 0, 0, 0];

function batch(...ids: number[]) {
  return json({ data: ids.map((id, index) => ({ index, embedding: vector(id) })) });
}

async function failure(...replies: Parameters<typeof stubFetch>): Promise<IngestionError> {
  const error = await embeddings(...replies)
    .provider.embed(['a'])
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IngestionError);
  return error as IngestionError;
}

describe('OpenAI embeddings', () => {
  it('sends the texts with the model and dimensions, and returns one vector per text', async () => {
    const { provider, requests } = embeddings(batch(1, 2));

    const vectors = await provider.embed(['first', 'second']);

    expect(vectors).toEqual([vector(1), vector(2)]);
    expect(provider.model).toBe('text-embedding-3-small');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.href).toBe('https://api.openai.com/v1/embeddings');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test');
    expect(requests[0]?.body).toEqual({
      model: 'text-embedding-3-small',
      input: ['first', 'second'],
      dimensions: DIMENSIONS,
      encoding_format: 'float',
    });
  });

  it('splits the texts into batches and keeps the order across them', async () => {
    const { provider, requests } = embeddings(batch(1, 2), batch(3, 4), batch(5));

    const vectors = await provider.embed(['a', 'b', 'c', 'd', 'e']);

    expect(vectors).toEqual([1, 2, 3, 4, 5].map(vector));
    expect(requests.map((r) => (r.body as { input: string[] }).input)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });

  it('orders vectors by the index the API reports, not by response order', async () => {
    const { provider } = embeddings(
      json({
        data: [
          { index: 1, embedding: vector(2) },
          { index: 0, embedding: vector(1) },
        ],
      }),
    );

    expect(await provider.embed(['a', 'b'])).toEqual([vector(1), vector(2)]);
  });

  it('no texts → no API call', async () => {
    const { provider, requests } = embeddings();

    expect(await provider.embed([])).toEqual([]);
    expect(requests).toEqual([]);
  });

  it.each([
    [
      'rate limited',
      429,
      { error: { message: 'Slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded' } },
    ],
    ['server error', 500, { error: { message: 'Oops', type: 'server_error' } }],
    ['overloaded', 503, { error: { message: 'Overloaded' } }],
  ])('%s (%i) → transient', async (_label, status, body) => {
    expect(await failure(json(body, status))).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
    });
  });

  it('timeout, network failure and a non-JSON gateway error → transient', async () => {
    expect(await failure(timeoutError())).toMatchObject({ retryable: true });
    expect(await failure(new TypeError('fetch failed'))).toMatchObject({ retryable: true });
    expect(await failure(new Response('<html>502</html>', { status: 502 }))).toMatchObject({
      retryable: true,
    });
  });

  it.each([
    ['out of credits', 429, 'insufficient_quota'],
    ['bad key', 401, 'invalid_api_key'],
    ['input too long', 400, 'context_length_exceeded'],
    ['unknown model', 404, 'model_not_found'],
  ])(
    '%s (%i) → permanent, vendor detail kept for the log but not shown',
    async (_l, status, code) => {
      const error = await failure(json({ error: { message: 'Details', type: 'x', code } }, status));

      expect(error).toMatchObject({ code: 'PROCESSING_FAILED', retryable: false });
      expect(error.message).toBe("We couldn't index this source. Please try again later.");
      expect((error.cause as Error).message).toBe(`OpenAI ${status} ${code}: Details`);
    },
  );

  it('a failing batch fails the whole call (nothing partial is returned)', async () => {
    const { provider } = embeddings(batch(1, 2), json({ error: { message: 'Oops' } }, 500));

    await expect(provider.embed(['a', 'b', 'c'])).rejects.toMatchObject({ retryable: true });
  });

  it.each([
    ['a missing vector', json({ data: [{ index: 0, embedding: vector(1) }] })],
    [
      'the wrong number of dimensions',
      json({
        data: [
          { index: 0, embedding: [1, 2] },
          { index: 1, embedding: [1, 2] },
        ],
      }),
    ],
    ['an unexpected body', json({ object: 'list' })],
  ])('a 200 with %s → transient', async (_label, reply) => {
    const { provider } = embeddings(reply);

    await expect(provider.embed(['a', 'b'])).rejects.toMatchObject({ retryable: true });
  });
});
