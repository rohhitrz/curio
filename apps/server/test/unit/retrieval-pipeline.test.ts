import { describe, expect, it } from 'vitest';
import { retrieval, type RetrievalFlags } from '../../src/config/index.js';
import { fuseRankLists } from '../../src/pipelines/retrieval/fusion.js';
import {
  runRetrieval,
  type QueryUnderstanding,
  type RetrievalPipelineDeps,
} from '../../src/pipelines/retrieval/pipeline.js';
import type { ChunkMatch, RetrievedChunk } from '../../src/pipelines/retrieval/retrieve.js';
import { createFakeEmbeddings } from '../fakes/embeddings.js';

const allOff: RetrievalFlags = {
  queryRewrite: false,
  hybridSearch: false,
  rerank: false,
  subQueries: false,
  hyde: false,
};

function match(id: string, distance = 0.2): ChunkMatch {
  return {
    chunkId: id,
    sourceId: 'source-1',
    sourceTitle: 'ML notes',
    sourceType: 'PDF',
    chunkIndex: 0,
    content: `content of ${id}`,
    contextHeader: 'ML notes',
    pageNumber: 1,
    startSeconds: null,
    endSeconds: null,
    headingPath: null,
    charStart: null,
    charEnd: null,
    distance,
  };
}

function chunk(id: string, rank = 1): RetrievedChunk {
  const {
    distance,
    pageNumber,
    startSeconds,
    endSeconds,
    headingPath,
    charStart,
    charEnd,
    ...rest
  } = match(id);
  return {
    ...rest,
    rank,
    location: { pageNumber, startSeconds, endSeconds, headingPath, charStart, charEnd },
    score: 1 - distance,
  };
}

/** Fake steps that record their calls. Vector search returns `vector:<query>-<n>` chunk IDs. */
function setup(
  flags: Partial<RetrievalFlags> = {},
  understanding: QueryUnderstanding = {
    needsRetrieval: true,
    standaloneQuery: 'rewritten question',
    subQueries: [],
  },
) {
  const embeddings = createFakeEmbeddings();
  const calls = {
    vector: [] as number[],
    understand: [] as { question: string; history: unknown[] }[],
    keyword: [] as string[],
    rerank: [] as { query: string; ids: string[]; topK: number }[],
    steps: [] as string[],
  };
  const searchedText: string[] = [];
  const deps: RetrievalPipelineDeps = {
    flags: { ...allOff, ...flags },
    embeddings: {
      model: 'fake',
      async embed(texts) {
        searchedText.push(...texts);
        return embeddings.provider.embed(texts);
      },
    },
    vectorSearch: (params) => {
      calls.vector.push(params.limit);
      const query = searchedText[calls.vector.length - 1] ?? '';
      return Promise.resolve([match(`vector:${query}-1`, 0.1), match(`vector:${query}-2`, 0.3)]);
    },
    understandQuery: (input) => {
      calls.understand.push(input);
      return Promise.resolve(understanding);
    },
    keywordSearch: (params) => {
      calls.keyword.push(params.query);
      return Promise.resolve([chunk(`keyword:${params.query}-1`)]);
    },
    rerank: (input) => {
      calls.rerank.push({
        query: input.query,
        ids: input.chunks.map((c) => c.chunkId),
        topK: input.topK,
      });
      return Promise.resolve([...input.chunks].reverse().slice(0, input.topK));
    },
    step: (name, _input, fn) => {
      calls.steps.push(name);
      return fn();
    },
  };
  return { deps, calls, searchedText };
}

const input = {
  userId: 'user-1',
  notebookId: 'notebook-1',
  question: 'What are its disadvantages?',
  history: [{ role: 'user' as const, content: 'Tell me about dropout.' }],
};

describe('runRetrieval', () => {
  it('with every flag off, is vector search on the raw question and nothing else', async () => {
    const { deps, calls, searchedText } = setup();

    const result = await runRetrieval(input, deps);

    expect(searchedText).toEqual(['What are its disadvantages?']);
    expect(calls.vector).toEqual([retrieval.vectorCandidates]);
    expect(calls.understand).toEqual([]);
    expect(calls.keyword).toEqual([]);
    expect(calls.rerank).toEqual([]);
    expect(calls.steps).toEqual(['search']);
    expect(result).toMatchObject({
      retrieved: true,
      queries: ['What are its disadvantages?'],
      steps: { understand: false, keyword: false, fusion: false, rerank: false },
    });
    // Unfused, the vector scores (cosine similarity) are kept.
    expect(result.chunks.map((c) => [c.rank, c.chunkId, c.score])).toEqual([
      [1, 'vector:What are its disadvantages?-1', 0.9],
      [2, 'vector:What are its disadvantages?-2', 0.7],
    ]);
  });

  it('cuts the results to topK (rerankTopK by default)', async () => {
    const { deps } = setup();
    expect((await runRetrieval({ ...input, topK: 1 }, deps)).chunks).toHaveLength(1);
  });

  it('queryRewrite on: searches the standalone query, given the history', async () => {
    const { deps, calls, searchedText } = setup({ queryRewrite: true });

    const result = await runRetrieval(input, deps);

    expect(calls.understand).toEqual([{ question: input.question, history: input.history }]);
    expect(searchedText).toEqual(['rewritten question']);
    expect(result.queries).toEqual(['rewritten question']);
    expect(result.steps.understand).toBe(true);
    expect(calls.steps).toEqual(['understand', 'search']);
  });

  it('queryRewrite on: a blank rewrite falls back to the raw question', async () => {
    const { deps, searchedText } = setup(
      { queryRewrite: true },
      { needsRetrieval: true, standaloneQuery: '  ', subQueries: [] },
    );
    await runRetrieval(input, deps);
    expect(searchedText).toEqual([input.question]);
  });

  it('queryRewrite on: routing can skip the search ("thanks!")', async () => {
    const { deps, calls } = setup(
      { queryRewrite: true, hybridSearch: true, rerank: true },
      { needsRetrieval: false, standaloneQuery: 'thanks!', subQueries: [] },
    );

    const result = await runRetrieval({ ...input, question: 'thanks!' }, deps);

    expect(result).toMatchObject({ retrieved: false, queries: [], chunks: [] });
    expect(calls.vector).toEqual([]);
    expect(calls.keyword).toEqual([]);
    expect(calls.rerank).toEqual([]);
  });

  it('a failed understanding call is skipped: raw question searched, failure reported', async () => {
    const { deps, searchedText } = setup({ queryRewrite: true, subQueries: true });
    const error = new Error('LLM down');
    deps.understandQuery = () => Promise.reject(error);
    const reported: [string, unknown][] = [];
    deps.onStepFailed = (step, err) => reported.push([step, err]);

    const result = await runRetrieval(input, deps);

    expect(searchedText).toEqual([input.question]);
    expect(result).toMatchObject({
      retrieved: true,
      queries: [input.question],
      failed: ['understand'],
      steps: { understand: false },
    });
    expect(reported).toEqual([['understand', error]]);
  });

  it('subQueries on alone: searches the raw question plus each sub-query, fused', async () => {
    const { deps, searchedText, calls } = setup(
      { subQueries: true },
      {
        needsRetrieval: false,
        standaloneQuery: 'ignored',
        subQueries: ['dropout', 'What are its disadvantages?', 'batch norm'],
      },
    );

    const result = await runRetrieval(input, deps);

    // Rewrite and routing stay off; a sub-query equal to the question isn't searched twice.
    expect(result.retrieved).toBe(true);
    expect(searchedText).toEqual([input.question, 'dropout', 'batch norm']);
    expect(calls.vector).toHaveLength(3);
    expect(result.steps).toEqual({ understand: true, keyword: false, fusion: true, rerank: false });
  });

  it('hybridSearch on: a keyword search next to each vector search, fused with RRF', async () => {
    const { deps, calls } = setup({ hybridSearch: true });

    const result = await runRetrieval(input, deps);

    expect(calls.keyword).toEqual([input.question]);
    expect(result.steps).toMatchObject({ keyword: true, fusion: true });
    expect(result.chunks.map((c) => c.chunkId)).toEqual([
      // Rank 1 in both lists ties on RRF score; the vector list comes first.
      'vector:What are its disadvantages?-1',
      'keyword:What are its disadvantages?-1',
      'vector:What are its disadvantages?-2',
    ]);
    expect(result.chunks[0]?.score).toBeCloseTo(1 / (retrieval.rrfK + 1));
  });

  it('rerank on: reorders the candidates and keeps topK', async () => {
    const { deps, calls } = setup({ rerank: true });

    const result = await runRetrieval({ ...input, topK: 1 }, deps);

    expect(calls.rerank).toEqual([
      {
        query: input.question,
        ids: ['vector:What are its disadvantages?-1', 'vector:What are its disadvantages?-2'],
        topK: 1,
      },
    ]);
    expect(result.chunks.map((c) => [c.rank, c.chunkId])).toEqual([
      [1, 'vector:What are its disadvantages?-2'],
    ]);
    expect(calls.steps).toEqual(['search', 'rerank']);
  });

  it('rerank on: nothing found → no rerank call', async () => {
    const { deps, calls } = setup({ rerank: true });
    deps.vectorSearch = () => Promise.resolve([]);

    const result = await runRetrieval(input, deps);

    expect(result.chunks).toEqual([]);
    expect(calls.rerank).toEqual([]);
  });

  it('a flag on without its step throws before calling anything', async () => {
    const { deps, calls } = setup({ queryRewrite: true, hybridSearch: true, rerank: true });
    delete deps.understandQuery;
    delete deps.keywordSearch;
    delete deps.rerank;

    await expect(runRetrieval(input, deps)).rejects.toThrow(
      'Retrieval flags are on without their steps: understandQuery, keywordSearch, rerank',
    );
    expect(calls.vector).toEqual([]);
  });

  it('a step that is off may be missing', async () => {
    const { deps } = setup();
    delete deps.understandQuery;
    delete deps.keywordSearch;
    delete deps.rerank;
    await expect(runRetrieval(input, deps)).resolves.toMatchObject({ retrieved: true });
  });
});

describe('fuseRankLists (RRF)', () => {
  it('sums 1 / (k + rank) across lists and ranks by the sum', () => {
    const fused = fuseRankLists(
      [
        [chunk('a'), chunk('b'), chunk('c')],
        [chunk('c'), chunk('d')],
      ],
      { k: 60, limit: 10 },
    );
    expect(fused.map((c) => [c.rank, c.chunkId])).toEqual([
      [1, 'c'],
      [2, 'a'],
      [3, 'b'],
      [4, 'd'],
    ]);
    expect(fused[0]?.score).toBeCloseTo(1 / 63 + 1 / 61);
  });

  it('keeps at most `limit` chunks', () => {
    expect(fuseRankLists([[chunk('a'), chunk('b')]], { k: 60, limit: 1 })).toHaveLength(1);
  });

  it('handles no lists', () => {
    expect(fuseRankLists([], { k: 60, limit: 5 })).toEqual([]);
  });
});
