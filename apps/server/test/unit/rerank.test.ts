import { describe, expect, it } from 'vitest';
import { RerankError } from '../../src/errors/rerank-error.js';
import { createCohereRerank } from '../../src/lib/rerank/index.js';
import type { RerankProvider } from '../../src/lib/rerank/index.js';
import { rerankChunks, rerankDocument } from '../../src/pipelines/retrieval/rerank.js';
import type { RetrievedChunk } from '../../src/pipelines/retrieval/retrieve.js';
import { json, stubFetch, timeoutError } from '../helpers/fetch.js';

function cohere(...replies: Parameters<typeof stubFetch>) {
  const stub = stubFetch(...replies);
  const provider = createCohereRerank({
    apiKey: 'co-test',
    model: 'rerank-v4.0-pro',
    timeoutMs: 3_000,
    maxTokensPerDoc: 1_024,
    fetch: stub.fetch,
  });
  return { provider, requests: stub.requests };
}

const reply = (results: { index: number; relevance_score: number }[], searchUnits = 1) =>
  json({ id: 'r-1', results, meta: { billed_units: { search_units: searchUnits } } });

async function failure(promise: Promise<unknown>): Promise<RerankError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RerankError);
  return error as RerankError;
}

describe('Cohere rerank provider', () => {
  it('posts the query and documents to /v2/rerank and returns results best first', async () => {
    const { provider, requests } = cohere(
      reply([
        { index: 2, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.4 },
      ]),
    );

    const result = await provider.rerank({ query: 'q', documents: ['a', 'b', 'c'], topN: 2 });

    expect(result).toEqual({
      results: [
        { index: 2, score: 0.9 },
        { index: 0, score: 0.4 },
      ],
      model: 'rerank-v4.0-pro',
      searchUnits: 1,
    });
    const [request] = requests;
    expect(request?.url.href).toBe('https://api.cohere.com/v2/rerank');
    expect(request?.headers.get('authorization')).toBe('Bearer co-test');
    expect(request?.body).toEqual({
      model: 'rerank-v4.0-pro',
      query: 'q',
      documents: ['a', 'b', 'c'],
      top_n: 2,
      max_tokens_per_doc: 1_024,
    });
  });

  it('no documents → no call', async () => {
    const { provider, requests } = cohere();
    expect(await provider.rerank({ query: 'q', documents: [], topN: 5 })).toMatchObject({
      results: [],
    });
    expect(requests).toEqual([]);
  });

  it('sorts by score and keeps topN even if the API does not', async () => {
    const { provider } = cohere(
      reply([
        { index: 0, relevance_score: 0.1 },
        { index: 1, relevance_score: 0.8 },
        { index: 2, relevance_score: 0.5 },
      ]),
    );
    const { results } = await provider.rerank({ query: 'q', documents: ['a', 'b', 'c'], topN: 2 });
    expect(results.map((r) => r.index)).toEqual([1, 2]);
  });

  it('a timeout or network failure is retryable', async () => {
    const { provider } = cohere(timeoutError());
    expect(
      (await failure(provider.rerank({ query: 'q', documents: ['a'], topN: 1 }))).retryable,
    ).toBe(true);
  });

  it('429 and 5xx are retryable; 400 and 401 are not', async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [400, false],
      [401, false],
    ] as const) {
      const { provider } = cohere(json({ message: 'nope' }, status));
      const error = await failure(provider.rerank({ query: 'q', documents: ['a'], topN: 1 }));
      expect(error.retryable).toBe(retryable);
      expect(error.message).toContain(String(status));
    }
  });

  it('an unexpected body or an out-of-range index fails', async () => {
    const wrongShape = cohere(json({ results: 'nope' }));
    await failure(wrongShape.provider.rerank({ query: 'q', documents: ['a'], topN: 1 }));
    const outOfRange = cohere(reply([{ index: 5, relevance_score: 0.9 }]));
    await failure(outOfRange.provider.rerank({ query: 'q', documents: ['a'], topN: 1 }));
  });
});

function chunk(id: string): RetrievedChunk {
  return {
    rank: 1,
    chunkId: id,
    sourceId: 'source-1',
    sourceTitle: 'Notes',
    sourceType: 'TEXT',
    chunkIndex: 0,
    content: `content ${id}`,
    contextHeader: `Notes > ${id}`,
    location: {
      pageNumber: null,
      startSeconds: null,
      endSeconds: null,
      headingPath: null,
      charStart: null,
      charEnd: null,
    },
    score: 0.016,
  };
}

describe('rerankChunks', () => {
  it('sends header + content, returns the chunks in the reranker’s order with its scores', async () => {
    const calls: Parameters<RerankProvider['rerank']>[0][] = [];
    const reranker: RerankProvider = {
      model: 'fake',
      rerank(request) {
        calls.push(request);
        return Promise.resolve({
          results: [
            { index: 1, score: 0.92 },
            { index: 0, score: 0.31 },
          ],
          model: 'fake',
          searchUnits: 1,
        });
      },
    };
    const units: number[] = [];

    const result = await rerankChunks(
      { query: 'q', chunks: [chunk('a'), chunk('b'), chunk('c')], topK: 2 },
      { reranker, onSearchUnits: (n) => units.push(n) },
    );

    expect(calls).toEqual([
      {
        query: 'q',
        documents: ['Notes > a\n\ncontent a', 'Notes > b\n\ncontent b', 'Notes > c\n\ncontent c'],
        topN: 2,
      },
    ]);
    expect(result.map((c) => [c.rank, c.chunkId, c.score])).toEqual([
      [1, 'b', 0.92],
      [2, 'a', 0.31],
    ]);
    expect(units).toEqual([1]);
    expect(rerankDocument(chunk('x'))).toBe('Notes > x\n\ncontent x');
  });

  it('no chunks → no call', async () => {
    const reranker: RerankProvider = {
      model: 'fake',
      rerank: () => Promise.reject(new Error('should not be called')),
    };
    expect(await rerankChunks({ query: 'q', chunks: [], topK: 5 }, { reranker })).toEqual([]);
  });
});
