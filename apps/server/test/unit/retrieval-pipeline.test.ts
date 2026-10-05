import { describe, expect, it } from 'vitest';
import { retrieval, type RetrievalFlags } from '../../src/config/index.js';
import { fuseRankLists } from '../../src/pipelines/retrieval/fusion.js';
import { mergeRerankedLists } from '../../src/pipelines/retrieval/rerank.js';
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
  relevanceGate: false,
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
      const { distance: _distance, ...row } = match(`keyword:${params.query}-1`);
      return Promise.resolve([{ ...row, textRank: 0.5 }]);
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

    expect(calls.understand).toEqual([
      {
        question: input.question,
        history: input.history,
        abortSignal: expect.any(AbortSignal) as unknown,
      },
    ]);
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
    expect(result.steps).toEqual({
      understand: true,
      hyde: false,
      keyword: false,
      fusion: true,
      rerank: false,
      gate: false,
    });
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

  it('rerank down: the fused order is kept and the failure reported', async () => {
    const { deps } = setup({ rerank: true });
    const error = new Error('Cohere down');
    deps.rerank = () => Promise.reject(error);
    const reported: [string, unknown][] = [];
    deps.onStepFailed = (step, err) => reported.push([step, err]);

    const result = await runRetrieval({ ...input, topK: 1 }, deps);

    expect(result.chunks.map((c) => c.chunkId)).toEqual(['vector:What are its disadvantages?-1']);
    expect(result).toMatchObject({ failed: ['rerank'], steps: { rerank: false } });
    expect(reported).toEqual([['rerank', error]]);
  });

  it('rerank on: nothing found → no rerank call', async () => {
    const { deps, calls } = setup({ rerank: true });
    deps.vectorSearch = () => Promise.resolve([]);

    const result = await runRetrieval(input, deps);

    expect(result.chunks).toEqual([]);
    expect(calls.rerank).toEqual([]);
  });

  describe('multi-part questions: rerank and gate per part (R-11)', () => {
    const parts: QueryUnderstanding = {
      needsRetrieval: true,
      standaloneQuery: 'Compare ridge and lasso',
      subQueries: ['ridge penalty', 'lasso penalty'],
    };
    /** Each query's own list: its chunk first with the given score, then the shared chunk. */
    const scoredByQuery = (deps: RetrievalPipelineDeps, scores: Record<string, number>) => {
      deps.rerank = ({ query, chunks: candidates }) => {
        const own = candidates.find((c) => c.chunkId === `vector:${query}-1`);
        const shared = candidates.find((c) => c.chunkId === 'vector:Compare ridge and lasso-2');
        return Promise.resolve(
          [own, shared].flatMap((c, i) =>
            c ? [{ ...c, score: (scores[query] ?? 0) - i * 0.1 }] : [],
          ),
        );
      };
    };

    it('reranks against the whole question and each part, merged in turns', async () => {
      const { deps, calls } = setup({ queryRewrite: true, subQueries: true, rerank: true }, parts);

      const result = await runRetrieval(input, deps);

      expect(calls.rerank.map((c) => c.query)).toEqual([
        'Compare ridge and lasso',
        'ridge penalty',
        'lasso penalty',
      ]);
      // Every call sees the same fused candidates.
      expect(new Set(calls.rerank.map((c) => c.ids.join()))).toHaveProperty('size', 1);
      expect(result.steps.rerank).toBe(true);
    });

    it('a part is relevant though the whole question scores low → not gated', async () => {
      const { deps } = setup(
        { queryRewrite: true, subQueries: true, rerank: true, relevanceGate: true },
        parts,
      );
      scoredByQuery(deps, {
        'Compare ridge and lasso': 0.6,
        'ridge penalty': 0.9,
        'lasso penalty': 0.8,
      });

      const result = await runRetrieval(input, { ...deps, relevanceThreshold: 0.7 });

      expect(result).toMatchObject({ gated: false, gateScore: 0.9 });
      // Turns: each list's #1, then the shared #2 once, with its best score.
      expect(result.chunks.map((c) => [c.rank, c.chunkId, c.score])).toEqual([
        [1, 'vector:Compare ridge and lasso-1', 0.6],
        [2, 'vector:ridge penalty-1', 0.9],
        [3, 'vector:lasso penalty-1', 0.8],
        [4, 'vector:Compare ridge and lasso-2', expect.closeTo(0.8)],
      ]);
    });

    it('no part relevant → gated', async () => {
      const { deps } = setup(
        { queryRewrite: true, subQueries: true, rerank: true, relevanceGate: true },
        parts,
      );
      scoredByQuery(deps, {
        'Compare ridge and lasso': 0.5,
        'ridge penalty': 0.6,
        'lasso penalty': 0.65,
      });

      const result = await runRetrieval(input, { ...deps, relevanceThreshold: 0.7 });

      expect(result).toMatchObject({ gated: true, gateScore: 0.65, chunks: [] });
    });

    it('one part’s rerank failing → fused order, gate skipped', async () => {
      const { deps } = setup(
        { queryRewrite: true, subQueries: true, rerank: true, relevanceGate: true },
        parts,
      );
      const error = new Error('Cohere 429');
      deps.rerank = ({ query, chunks: candidates, topK }) =>
        query === 'lasso penalty'
          ? Promise.reject(error)
          : Promise.resolve(candidates.slice(0, topK).map((c) => ({ ...c, score: 0.1 })));
      const reported: [string, unknown][] = [];
      deps.onStepFailed = (step, err) => reported.push([step, err]);

      const result = await runRetrieval({ ...input, topK: 2 }, deps);

      expect(result).toMatchObject({
        gated: false,
        failed: ['rerank'],
        steps: { rerank: false, gate: false },
      });
      expect(result.chunks).toHaveLength(2);
      expect(reported).toEqual([['rerank', error]]);
    });

    it('subQueries off → one rerank call, even if the model found parts', async () => {
      const { deps, calls } = setup({ queryRewrite: true, rerank: true }, parts);

      await runRetrieval(input, deps);

      expect(calls.rerank.map((c) => c.query)).toEqual(['Compare ridge and lasso']);
    });
  });

  describe('relevance gate (rerank + relevanceGate on)', () => {
    const withTopScore = (deps: RetrievalPipelineDeps, score: number) => {
      deps.rerank = ({ chunks }) =>
        Promise.resolve(chunks.slice(0, 1).map((c) => ({ ...c, score })));
    };

    it('top score below the threshold → no chunks, gated', async () => {
      const { deps } = setup({ rerank: true, relevanceGate: true });
      withTopScore(deps, 0.69);

      const result = await runRetrieval(input, { ...deps, relevanceThreshold: 0.7 });

      expect(result).toMatchObject({ retrieved: true, gated: true, chunks: [] });
      expect(result.steps.gate).toBe(true);
    });

    it('top score exactly at the threshold → passes', async () => {
      const { deps } = setup({ rerank: true, relevanceGate: true });
      withTopScore(deps, 0.7);

      const result = await runRetrieval(input, { ...deps, relevanceThreshold: 0.7 });

      expect(result.gated).toBe(false);
      expect(result.chunks).toHaveLength(1);
    });

    it('uses retrieval.relevanceThreshold by default', async () => {
      const { deps } = setup({ rerank: true, relevanceGate: true });
      withTopScore(deps, retrieval.relevanceThreshold - 0.01);
      expect((await runRetrieval(input, deps)).gated).toBe(true);
    });

    it('gate off → low scores still pass', async () => {
      const { deps } = setup({ rerank: true });
      withTopScore(deps, 0.01);
      const result = await runRetrieval(input, deps);
      expect(result).toMatchObject({ gated: false, steps: { gate: false } });
      expect(result.chunks).toHaveLength(1);
    });

    it('rerank failed → the gate is skipped (fused scores are not relevance)', async () => {
      const { deps } = setup({ rerank: true, relevanceGate: true });
      deps.rerank = () => Promise.reject(new Error('down'));

      const result = await runRetrieval({ ...input, topK: 1 }, deps);

      expect(result).toMatchObject({ gated: false, failed: ['rerank'], steps: { gate: false } });
      expect(result.chunks).toHaveLength(1);
    });

    it('relevanceGate without rerank is a wiring bug', async () => {
      const { deps } = setup({ relevanceGate: true });
      await expect(runRetrieval(input, deps)).rejects.toThrow(
        'the relevance gate needs its scores',
      );
    });
  });

  it('hyde on: one more vector search with the hypothetical passage, fused', async () => {
    const { deps, searchedText, calls } = setup({ hyde: true });
    deps.hypotheticalPassage = ({ question }) => Promise.resolve(`Passage answering: ${question}`);

    const result = await runRetrieval(input, deps);

    expect(searchedText).toEqual([input.question, `Passage answering: ${input.question}`]);
    expect(calls.keyword).toEqual([]);
    expect(result.steps).toMatchObject({ hyde: true, fusion: true });
    // The passage is a search input, not a query the user asked.
    expect(result.queries).toEqual([input.question]);
  });

  it('hyde fails: skipped, the question is still searched', async () => {
    const { deps, searchedText } = setup({ hyde: true });
    deps.hypotheticalPassage = () => Promise.reject(new Error('down'));

    const result = await runRetrieval(input, deps);

    expect(searchedText).toEqual([input.question]);
    expect(result).toMatchObject({ failed: ['hyde'], steps: { hyde: false, fusion: false } });
  });

  describe('timeouts and degradation (6.8)', () => {
    const never = () => new Promise<never>(() => undefined);
    const fast = { understandMs: 20, hydeMs: 20 };

    it('understanding past its deadline → raw question searched', async () => {
      const { deps, searchedText } = setup({ queryRewrite: true });
      let aborted: AbortSignal | undefined;
      deps.understandQuery = ({ abortSignal }) => {
        aborted = abortSignal;
        return never();
      };

      const result = await runRetrieval(input, { ...deps, timeouts: fast });

      expect(searchedText).toEqual([input.question]);
      expect(result.failed).toEqual(['understand']);
      expect(aborted?.aborted).toBe(true);
    });

    it('HyDE past its deadline → skipped', async () => {
      const { deps, searchedText } = setup({ hyde: true });
      deps.hypotheticalPassage = never;

      const result = await runRetrieval(input, { ...deps, timeouts: fast });

      expect(searchedText).toEqual([input.question]);
      expect(result).toMatchObject({ failed: ['hyde'], steps: { hyde: false } });
    });

    it('keyword search down → vector results only, failure reported', async () => {
      const { deps } = setup({ hybridSearch: true });
      deps.keywordSearch = () => Promise.reject(new Error('db timeout'));
      const reported: string[] = [];
      deps.onStepFailed = (step) => reported.push(step);

      const result = await runRetrieval(input, deps);

      expect(result.chunks.map((c) => c.chunkId)).toEqual([
        'vector:What are its disadvantages?-1',
        'vector:What are its disadvantages?-2',
      ]);
      expect(result).toMatchObject({ failed: ['keywordSearch'], steps: { fusion: false } });
      expect(reported).toEqual(['keywordSearch']);
    });

    it('vector search down (embeddings timeout) → keyword results only', async () => {
      const { deps } = setup({ hybridSearch: true });
      deps.embeddings = { model: 'fake', embed: () => Promise.reject(new Error('timeout')) };

      const result = await runRetrieval(input, deps);

      expect(result.chunks.map((c) => c.chunkId)).toEqual([
        'keyword:What are its disadvantages?-1',
      ]);
      expect(result.failed).toEqual(['vectorSearch']);
    });

    it('every search down → the error is thrown (no answer without sources)', async () => {
      const { deps } = setup({ hybridSearch: true });
      deps.embeddings = { model: 'fake', embed: () => Promise.reject(new Error('embed down')) };
      deps.keywordSearch = () => Promise.reject(new Error('db down'));

      await expect(runRetrieval(input, deps)).rejects.toThrow('embed down');
    });
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

describe('mergeRerankedLists', () => {
  const scored = (id: string, score: number) => ({ ...chunk(id), score });

  it('one list comes back as it was, cut to topK', () => {
    const list = [scored('a', 0.9), scored('b', 0.5), scored('c', 0.4)];
    expect(mergeRerankedLists([list], 2).map((c) => [c.rank, c.chunkId])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });

  it('takes turns across lists; a repeat keeps its first place and its best score', () => {
    const merged = mergeRerankedLists(
      [
        [scored('a', 0.5), scored('shared', 0.4)],
        [scored('shared', 0.95), scored('b', 0.3)],
        [scored('c', 0.8)],
      ],
      10,
    );
    expect(merged.map((c) => [c.rank, c.chunkId, c.score])).toEqual([
      [1, 'a', 0.5],
      [2, 'shared', 0.95],
      [3, 'c', 0.8],
      [4, 'b', 0.3],
    ]);
  });

  it('handles no lists and empty lists', () => {
    expect(mergeRerankedLists([], 8)).toEqual([]);
    expect(mergeRerankedLists([[], []], 8)).toEqual([]);
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
