import { z } from 'zod';
import { IngestionError } from '../../errors/ingestion-error.js';
import { readJson, request } from '../http-request.js';
import type { EmbeddingsProvider } from './types.js';

export interface OpenAiEmbeddingsConfig {
  apiKey: string;
  model: string;
  dimensions: number;
  /** Texts per API call. */
  batchSize: number;
  /** Per API call. */
  timeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.openai.com';

const embeddingsResponse = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

const errorResponse = z.object({
  error: z.object({
    message: z.string().nullish(),
    type: z.string().nullish(),
    code: z.string().nullish(),
  }),
});

const messages = {
  unreachable: "We couldn't reach the indexing service. Please try again.",
  busy: 'The indexing service is busy right now. Please try again in a few minutes.',
  failed: "We couldn't index this source. Please try again later.",
};

function failure(status: number, body: unknown): IngestionError {
  const parsed = errorResponse.safeParse(body);
  const code = parsed.success ? (parsed.data.error.code ?? parsed.data.error.type ?? '') : '';
  const detail = parsed.success ? (parsed.data.error.message ?? '') : 'no error body';
  const cause = new Error(`OpenAI ${status}${code ? ` ${code}` : ''}: ${detail}`);

  // Out of credits is also a 429, but waiting doesn't fix it.
  if (code === 'insufficient_quota') {
    return IngestionError.permanent('PROCESSING_FAILED', messages.failed, { cause });
  }
  if (status === 429) return IngestionError.transient(messages.busy, { cause });
  if (status === 408 || status === 409 || status >= 500) {
    return IngestionError.transient(messages.unreachable, { cause });
  }
  // 400 (bad input), 401/403 (our key), 404 (unknown model): retrying won't fix it.
  return IngestionError.permanent('PROCESSING_FAILED', messages.failed, { cause });
}

function unexpected(detail: string, cause?: unknown): IngestionError {
  return IngestionError.transient(messages.unreachable, {
    cause: new Error(`OpenAI returned an unexpected embeddings response: ${detail}`, { cause }),
  });
}

export function createOpenAiEmbeddings(config: OpenAiEmbeddingsConfig): EmbeddingsProvider {
  const endpoint = new URL('/v1/embeddings', config.baseUrl ?? DEFAULT_BASE_URL);

  async function embedBatch(texts: string[]): Promise<number[][]> {
    const response = await request(
      endpoint,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          input: texts,
          dimensions: config.dimensions,
          encoding_format: 'float',
        }),
      },
      {
        fetch: config.fetch ?? fetch,
        timeoutMs: config.timeoutMs,
        unreachableMessage: messages.unreachable,
      },
    );

    const body = await readJson(response);
    if (!response.ok) throw failure(response.status, body);

    const parsed = embeddingsResponse.safeParse(body);
    if (!parsed.success) throw unexpected('wrong shape', parsed.error);

    // The API tags each vector with its input's index; don't rely on the response order.
    const vectors = new Array<number[] | undefined>(texts.length);
    for (const { index, embedding } of parsed.data.data) vectors[index] = embedding;

    return texts.map((_, index) => {
      const vector = vectors[index];
      if (!vector) throw unexpected(`no vector for input ${index}`);
      if (vector.length !== config.dimensions) {
        throw unexpected(`${vector.length} dimensions instead of ${config.dimensions}`);
      }
      return vector;
    });
  }

  return {
    model: config.model,

    async embed(texts) {
      const vectors: number[][] = [];
      // One batch at a time: a source's chunks fit in a few calls, and this stays under rate limits.
      for (let start = 0; start < texts.length; start += config.batchSize) {
        vectors.push(...(await embedBatch(texts.slice(start, start + config.batchSize))));
      }
      return vectors;
    },
  };
}
