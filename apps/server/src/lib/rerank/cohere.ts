import { z } from 'zod';
import { RerankError } from '../../errors/rerank-error.js';
import { readJson, type HttpResponse } from '../http-request.js';
import type { RerankProvider } from './types.js';

export interface CohereRerankConfig {
  apiKey: string;
  model: string;
  /** Whole call. */
  timeoutMs: number;
  /** Longer documents are cut by Cohere to this many tokens. */
  maxTokensPerDoc: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.cohere.com';

const rerankResponse = z.object({
  results: z.array(z.object({ index: z.number().int(), relevance_score: z.number() })),
  meta: z
    .object({ billed_units: z.object({ search_units: z.number().nullish() }).nullish() })
    .nullish(),
});

/** Cohere's Rerank API v2 (`POST /v2/rerank`). */
export function createCohereRerank(config: CohereRerankConfig): RerankProvider {
  const endpoint = new URL('/v2/rerank', config.baseUrl ?? DEFAULT_BASE_URL);
  const doFetch = config.fetch ?? fetch;

  return {
    model: config.model,

    async rerank({ query, documents, topN }) {
      if (documents.length === 0) return { results: [], model: config.model, searchUnits: 0 };

      let response: HttpResponse;
      try {
        const raw: unknown = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model,
            query,
            documents,
            top_n: topN,
            max_tokens_per_doc: config.maxTokensPerDoc,
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        response = raw as HttpResponse;
      } catch (cause) {
        throw new RerankError(true, 'Cohere rerank unreachable or timed out', { cause });
      }

      const body = await readJson(response);
      if (!response.ok) {
        // 429 and 5xx can pass; 400 (bad input) and 401/403 (our key) won't.
        const retryable = response.status === 429 || response.status >= 500;
        throw new RerankError(
          retryable,
          `Cohere rerank ${String(response.status)}: ${((JSON.stringify(body) as string | undefined) ?? '').slice(0, 300)}`,
        );
      }

      const parsed = rerankResponse.safeParse(body);
      if (!parsed.success) {
        throw new RerankError(true, 'Cohere rerank returned an unexpected response', {
          cause: parsed.error,
        });
      }
      const results = parsed.data.results.map((r) => ({
        index: r.index,
        score: r.relevance_score,
      }));
      if (results.some((r) => r.index < 0 || r.index >= documents.length)) {
        throw new RerankError(true, 'Cohere rerank returned an index out of range');
      }
      return {
        results: results.sort((a, b) => b.score - a.score).slice(0, topN),
        model: config.model,
        searchUnits: parsed.data.meta?.billed_units?.search_units ?? 0,
      };
    },
  };
}
