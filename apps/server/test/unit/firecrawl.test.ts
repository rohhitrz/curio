import { describe, expect, it } from 'vitest';
import { json, stubFetch, timeoutError } from '../helpers/fetch.js';
import { ExtractionError } from '../../src/errors/extraction-error.js';
import { createFirecrawlScraper } from '../../src/lib/scraper/firecrawl.js';

const PAGE_URL = 'https://example.com/articles/rag';

function scraper(...replies: Parameters<typeof stubFetch>) {
  const stub = stubFetch(...replies);
  const provider = createFirecrawlScraper({
    apiKey: 'fc-test',
    timeoutMs: 60_000,
    fetch: stub.fetch,
  });
  return { provider, requests: stub.requests };
}

function page(data: object) {
  return json({ success: true, data });
}

async function failure(...replies: Parameters<typeof stubFetch>): Promise<ExtractionError> {
  const error = await scraper(...replies)
    .provider.scrape(PAGE_URL)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ExtractionError);
  return error as ExtractionError;
}

describe('Firecrawl scraper', () => {
  it('asks for the main content as markdown and returns it with the page title', async () => {
    const { provider, requests } = scraper(
      page({
        markdown: '\n# RAG\n\nRetrieval-augmented generation.\n',
        metadata: { title: '  RAG explained ', statusCode: 200 },
      }),
    );

    const result = await provider.scrape(PAGE_URL);

    expect(result).toEqual({
      title: 'RAG explained',
      markdown: '# RAG\n\nRetrieval-augmented generation.',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.href).toBe('https://api.firecrawl.dev/v2/scrape');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer fc-test');
    expect(requests[0]?.body).toEqual({
      url: PAGE_URL,
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: 55_000,
    });
  });

  it('a page without a title → title null; a list of titles → the first', async () => {
    const untitled = scraper(page({ markdown: 'Text.', metadata: { statusCode: 200 } }));
    const listed = scraper(page({ markdown: 'Text.', metadata: { title: ['One', 'Two'] } }));

    expect((await untitled.provider.scrape(PAGE_URL)).title).toBeNull();
    expect((await listed.provider.scrape(PAGE_URL)).title).toBe('One');
  });

  it.each([404, 410])('the page answered %i → permanent PAGE_NOT_FOUND', async (statusCode) => {
    const error = await failure(page({ markdown: '# Not found', metadata: { statusCode } }));

    expect(error).toMatchObject({ code: 'PAGE_NOT_FOUND', retryable: false });
  });

  it.each([401, 403])('the page answered %i → permanent PAGE_BLOCKED', async (statusCode) => {
    const error = await failure(page({ markdown: 'Sign in', metadata: { statusCode } }));

    expect(error).toMatchObject({ code: 'PAGE_BLOCKED', retryable: false });
  });

  it.each([429, 500, 503])('the page answered %i → transient', async (statusCode) => {
    const error = await failure(page({ markdown: 'Oops', metadata: { statusCode } }));

    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
  });

  it('a page with no readable text → permanent NO_TEXT', async () => {
    const error = await failure(page({ markdown: '  \n ', metadata: { statusCode: 200 } }));

    expect(error).toMatchObject({ code: 'NO_TEXT', retryable: false });
    expect(error.message).toBe('No readable text was found on this page.');
  });

  it.each([
    ['rate limited', 429, { error: 'Request rate limit exceeded.' }],
    ['scrape timeout', 408, { success: false, code: 'SCRAPE_TIMEOUT', error: 'Timed out' }],
    ['server error', 500, { success: false, code: 'UNKNOWN_ERROR', error: 'Unexpected' }],
    ['unavailable', 503, { success: false, code: 'request_unresolved', error: 'x' }],
    ['in flight', 409, { success: false, code: 'request_in_flight', error: 'x' }],
  ])('Firecrawl %s (%i) → transient', async (_label, status, body) => {
    const error = await failure(json(body, status));

    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
  });

  it('a gateway error page that is not JSON → transient', async () => {
    const error = await failure(new Response('<html>Bad gateway</html>', { status: 502 }));

    expect(error).toMatchObject({ retryable: true });
  });

  // Seen live: Firecrawl answers 200 with `success: false` when the scrape itself fails.
  it.each([200, 500])(
    'the address does not resolve (HTTP %i) → permanent PAGE_NOT_FOUND',
    async (status) => {
      const error = await failure(
        json({ success: false, code: 'SCRAPE_DNS_RESOLUTION_ERROR', error: 'DNS failed' }, status),
      );

      expect(error).toMatchObject({ code: 'PAGE_NOT_FOUND', retryable: false });
      expect(error.message).toContain("address couldn't be found");
    },
  );

  it('a failed scrape reported with a 200 → transient, never treated as content', async () => {
    const timedOut = await failure(json({ success: false, code: 'SCRAPE_TIMEOUT', error: 'x' }));
    const unknown = await failure(json({ success: false, code: 'SCRAPE_SITE_ERROR', error: 'x' }));

    expect(timedOut).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    expect(unknown).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    expect((unknown.cause as Error).message).toBe('Firecrawl 200 SCRAPE_SITE_ERROR: x');
  });

  it('Firecrawl refuses the site (403) → permanent PAGE_BLOCKED', async () => {
    const error = await failure(json({ success: false, error: 'Not supported' }, 403));

    expect(error).toMatchObject({ code: 'PAGE_BLOCKED', retryable: false });
  });

  it.each([
    ['bad key', 401, { success: false, error: 'Unauthorized' }],
    ['no credits', 402, { success: false, code: 'insufficient_credits', error: 'Payment' }],
  ])('%s (%i) → permanent, vendor detail kept for the log but not shown', async (_l, status, b) => {
    const error = await failure(json(b, status));

    expect(error).toMatchObject({ code: 'EXTRACTION_FAILED', retryable: false });
    expect(error.message).toBe("We couldn't read this website. Please try again later.");
    expect((error.cause as Error).message).toContain(`Firecrawl ${status}`);
  });

  it('timeout → transient', async () => {
    const error = await failure(timeoutError());

    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    expect(error.cause).toBeInstanceOf(DOMException);
  });

  it('network failure → transient', async () => {
    expect(await failure(new TypeError('fetch failed'))).toMatchObject({ retryable: true });
  });

  it('a 200 with an unexpected body → transient', async () => {
    expect(await failure(json({ success: true }))).toMatchObject({ retryable: true });
  });
});
