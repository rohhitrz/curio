import { describe, expect, it } from 'vitest';
import { SearchError } from '../../src/errors/search-error.js';
import { createTavilySearch } from '../../src/lib/search/index.js';
import { json, stubFetch, timeoutError } from '../helpers/fetch.js';

function tavily(...replies: Parameters<typeof stubFetch>) {
  const stub = stubFetch(...replies);
  const provider = createTavilySearch({
    apiKey: 'tvly-test',
    depth: 'basic',
    timeoutMs: 15_000,
    fetch: stub.fetch,
  });
  return { provider, requests: stub.requests };
}

async function failure(promise: Promise<unknown>): Promise<SearchError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SearchError);
  return error as SearchError;
}

describe('Tavily search provider', () => {
  it('posts the query to /search and maps the results', async () => {
    const { provider, requests } = tavily(
      json({
        query: 'deep learning',
        results: [
          {
            title: ' Deep Learning ',
            url: 'https://example.com/dl',
            content: ' An intro. ',
            score: 0.91,
          },
          { title: null, url: 'https://example.com/untitled', content: null, score: null },
        ],
      }),
    );

    const results = await provider.search({ query: 'deep learning', maxResults: 5 });

    expect(results).toEqual([
      { title: 'Deep Learning', url: 'https://example.com/dl', snippet: 'An intro.', score: 0.91 },
      {
        title: 'https://example.com/untitled',
        url: 'https://example.com/untitled',
        snippet: '',
        score: 0,
      },
    ]);
    const [request] = requests;
    expect(request?.url.href).toBe('https://api.tavily.com/search');
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('authorization')).toBe('Bearer tvly-test');
    expect(request?.body).toMatchObject({
      query: 'deep learning',
      search_depth: 'basic',
      max_results: 5,
      include_raw_content: false,
    });
    expect(request?.body).not.toHaveProperty('include_domains');
  });

  it('passes domain filters only when given', async () => {
    const { provider, requests } = tavily(json({ results: [] }));

    await provider.search({
      query: 'pytorch',
      maxResults: 3,
      includeDomains: ['pytorch.org'],
      excludeDomains: [],
    });

    expect(requests[0]?.body).toMatchObject({ include_domains: ['pytorch.org'] });
    expect(requests[0]?.body).not.toHaveProperty('exclude_domains');
  });

  it('drops results whose URL does not parse and keeps at most maxResults', async () => {
    const { provider } = tavily(
      json({
        results: [
          { title: 'Bad', url: 'not a url', content: 'x', score: 1 },
          { title: 'A', url: 'https://a.example', content: 'a', score: 0.9 },
          { title: 'B', url: 'https://b.example', content: 'b', score: 0.8 },
        ],
      }),
    );

    const results = await provider.search({ query: 'q', maxResults: 1 });

    expect(results.map((r) => r.url)).toEqual(['https://a.example']);
  });

  it('timeout or network failure → retryable', async () => {
    expect(
      (await failure(tavily(timeoutError()).provider.search({ query: 'q', maxResults: 1 })))
        .retryable,
    ).toBe(true);
    expect(
      (
        await failure(
          tavily(new TypeError('fetch failed')).provider.search({ query: 'q', maxResults: 1 }),
        )
      ).retryable,
    ).toBe(true);
  });

  it.each([
    [429, true],
    [500, true],
    [400, false],
    [401, false],
    [432, false],
    [433, false],
  ])('HTTP %i → retryable %s', async (status, retryable) => {
    const { provider } = tavily(json({ detail: { error: 'nope' } }, status));

    const error = await failure(provider.search({ query: 'q', maxResults: 1 }));

    expect(error.retryable).toBe(retryable);
    expect(error.message).toContain(String(status));
  });

  it('an unexpected body → retryable', async () => {
    const { provider } = tavily(json({ hits: [] }));

    expect((await failure(provider.search({ query: 'q', maxResults: 1 }))).retryable).toBe(true);
  });
});
