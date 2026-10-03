import { z } from 'zod';
import { SearchError } from '../../errors/search-error.js';
import { readJson, type HttpResponse } from '../http-request.js';
import type { SearchProvider } from './types.js';

export interface FirecrawlSearchConfig {
  apiKey: string;
  /** Whole call. */
  timeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev';

const searchResponse = z.object({
  success: z.literal(true),
  data: z.object({
    web: z
      .array(
        z.object({
          url: z.string(),
          title: z.string().nullish(),
          description: z.string().nullish(),
        }),
      )
      .nullish(),
  }),
});

/**
 * Firecrawl's Search API (`POST /v2/search`): the fallback when Tavily fails ("Tavily finds,
 * Firecrawl reads; each a fallback for the other"). It gives no relevance score, so results score
 * by rank.
 */
export function createFirecrawlSearch(config: FirecrawlSearchConfig): SearchProvider {
  const endpoint = new URL('/v2/search', config.baseUrl ?? DEFAULT_BASE_URL);
  const doFetch = config.fetch ?? fetch;

  return {
    async search({ query, maxResults, includeDomains, excludeDomains }) {
      let response: HttpResponse;
      try {
        const raw: unknown = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            query,
            limit: maxResults,
            sources: ['web'],
            timeout: config.timeoutMs,
            ...(includeDomains?.length ? { includeDomains } : {}),
            ...(excludeDomains?.length ? { excludeDomains } : {}),
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        response = raw as HttpResponse;
      } catch (cause) {
        throw new SearchError(true, 'Firecrawl search unreachable or timed out', { cause });
      }

      const body = await readJson(response);
      if (!response.ok) {
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        throw new SearchError(
          retryable,
          `Firecrawl search ${String(response.status)}: ${((JSON.stringify(body) as string | undefined) ?? '').slice(0, 300)}`,
        );
      }

      const parsed = searchResponse.safeParse(body);
      if (!parsed.success) {
        throw new SearchError(true, 'Firecrawl search returned an unexpected response', {
          cause: parsed.error,
        });
      }
      const results = (parsed.data.data.web ?? []).filter((r) => URL.canParse(r.url));
      return results.slice(0, maxResults).map((r, rank) => ({
        title: r.title?.trim() || r.url,
        url: r.url,
        snippet: r.description?.trim() ?? '',
        score: 1 - rank / Math.max(results.length, 1),
      }));
    },
  };
}
