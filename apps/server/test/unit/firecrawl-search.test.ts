import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { SearchError } from '../../src/errors/search-error.js';
import {
  createFirecrawlSearch,
  withSearchFallback,
  type SearchProvider,
} from '../../src/lib/search/index.js';
import { json, stubFetch, timeoutError } from '../helpers/fetch.js';

const logger = pino({ level: 'silent' });

function firecrawl(...replies: Parameters<typeof stubFetch>) {
  const stub = stubFetch(...replies);
  const provider = createFirecrawlSearch({
    apiKey: 'fc-test',
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

describe('Firecrawl search provider', () => {
  it('posts to /v2/search and scores results by rank', async () => {
    const { provider, requests } = firecrawl(
      json({
        success: true,
        data: {
          web: [
            { url: 'https://a.example', title: ' A ', description: ' First. ' },
            { url: 'https://b.example', title: null, description: null },
          ],
        },
        creditsUsed: 2,
      }),
    );

    const results = await provider.search({
      query: 'deep learning',
      maxResults: 5,
      includeDomains: ['youtube.com'],
    });

    expect(results).toEqual([
      { title: 'A', url: 'https://a.example', snippet: 'First.', score: 1 },
      { title: 'https://b.example', url: 'https://b.example', snippet: '', score: 0.5 },
    ]);
    expect(requests[0]?.url.href).toBe('https://api.firecrawl.dev/v2/search');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer fc-test');
    expect(requests[0]?.body).toMatchObject({
      query: 'deep learning',
      limit: 5,
      sources: ['web'],
      includeDomains: ['youtube.com'],
    });
  });

  it('no web results → empty list', async () => {
    const { provider } = firecrawl(json({ success: true, data: {} }));

    expect(await provider.search({ query: 'q', maxResults: 3 })).toEqual([]);
  });

  it.each([
    [408, true],
    [429, true],
    [500, true],
    [400, false],
    [402, false],
  ])('HTTP %i → retryable %s', async (status, retryable) => {
    const { provider } = firecrawl(json({ success: false, error: 'nope' }, status));

    expect((await failure(provider.search({ query: 'q', maxResults: 1 }))).retryable).toBe(
      retryable,
    );
  });

  it('timeout → retryable', async () => {
    const { provider } = firecrawl(timeoutError());

    expect((await failure(provider.search({ query: 'q', maxResults: 1 }))).retryable).toBe(true);
  });
});

describe('withSearchFallback', () => {
  const ok = (url: string): SearchProvider => ({
    search: () => Promise.resolve([{ title: url, url, snippet: '', score: 1 }]),
  });
  const failing = (retryable: boolean): SearchProvider => ({
    search: () => Promise.reject(new SearchError(retryable, 'down')),
  });

  it('primary works → its results; the fallback is not asked', async () => {
    let asked = false;
    const fallback: SearchProvider = {
      search: () => {
        asked = true;
        return Promise.resolve([]);
      },
    };

    const results = await withSearchFallback(ok('https://p.example'), fallback, logger).search({
      query: 'q',
      maxResults: 1,
    });

    expect(results[0]?.url).toBe('https://p.example');
    expect(asked).toBe(false);
  });

  it('primary fails → the fallback answers', async () => {
    const results = await withSearchFallback(
      failing(false),
      ok('https://f.example'),
      logger,
    ).search({ query: 'q', maxResults: 1 });

    expect(results[0]?.url).toBe('https://f.example');
  });

  it('both fail → retryable if either failure was', async () => {
    const search = (a: boolean, b: boolean) =>
      withSearchFallback(failing(a), failing(b), logger).search({ query: 'q', maxResults: 1 });

    expect((await failure(search(true, false))).retryable).toBe(true);
    expect((await failure(search(false, true))).retryable).toBe(true);
    expect((await failure(search(false, false))).retryable).toBe(false);
  });
});
