import { z } from 'zod';
import { SearchError } from '../../errors/search-error.js';
import { readJson, type HttpResponse } from '../http-request.js';
import type { SearchProvider } from './types.js';

export interface TavilySearchConfig {
  apiKey: string;
  /** `basic` (1 credit) or `advanced` (2 credits, better snippets). */
  depth: 'basic' | 'advanced';
  /** Whole call. */
  timeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.tavily.com';

const searchResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
      score: z.number().nullish(),
    }),
  ),
});

/** Tavily's Search API (`POST /search`). */
export function createTavilySearch(config: TavilySearchConfig): SearchProvider {
  const endpoint = new URL('/search', config.baseUrl ?? DEFAULT_BASE_URL);
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
            topic: 'general',
            search_depth: config.depth,
            max_results: maxResults,
            include_answer: false,
            include_raw_content: false,
            include_images: false,
            ...(includeDomains?.length ? { include_domains: includeDomains } : {}),
            ...(excludeDomains?.length ? { exclude_domains: excludeDomains } : {}),
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        response = raw as HttpResponse;
      } catch (cause) {
        throw new SearchError(true, 'Tavily search unreachable or timed out', { cause });
      }

      const body = await readJson(response);
      if (!response.ok) {
        // 429 and 5xx can pass. 400 (bad query), 401 (our key) and 432/433 (plan or spending
        // limit) won't fix themselves.
        const retryable = response.status === 429 || response.status >= 500;
        throw new SearchError(
          retryable,
          `Tavily search ${String(response.status)}: ${((JSON.stringify(body) as string | undefined) ?? '').slice(0, 300)}`,
        );
      }

      const parsed = searchResponse.safeParse(body);
      if (!parsed.success) {
        throw new SearchError(true, 'Tavily search returned an unexpected response', {
          cause: parsed.error,
        });
      }
      return parsed.data.results
        .filter((r) => URL.canParse(r.url))
        .map((r) => ({
          title: r.title?.trim() || r.url,
          url: r.url,
          snippet: r.content?.trim() ?? '',
          score: r.score ?? 0,
        }))
        .slice(0, maxResults);
    },
  };
}
