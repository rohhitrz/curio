import { describe, expect, it } from 'vitest';
import { retrieval } from '../../src/config/index.js';
import { IngestionError } from '../../src/errors/ingestion-error.js';
import {
  retrieve,
  type ChunkMatch,
  type RetrievalDeps,
} from '../../src/pipelines/retrieval/retrieve.js';
import { createFakeEmbeddings, fakeVector } from '../fakes/embeddings.js';

function match(overrides: Partial<ChunkMatch> = {}): ChunkMatch {
  return {
    chunkId: 'chunk-1',
    sourceId: 'source-1',
    sourceTitle: 'ML notes',
    sourceType: 'PDF',
    chunkIndex: 0,
    content: 'L2 regularization penalizes large weights.',
    contextHeader: 'ML notes',
    pageNumber: 12,
    startSeconds: null,
    endSeconds: null,
    headingPath: null,
    charStart: 100,
    charEnd: 142,
    distance: 0.25,
    ...overrides,
  };
}

function setup(matches: ChunkMatch[] = []) {
  const embeddings = createFakeEmbeddings();
  const searches: Parameters<RetrievalDeps['vectorSearch']>[0][] = [];
  const deps: RetrievalDeps = {
    embeddings: embeddings.provider,
    vectorSearch: (params) => {
      searches.push(params);
      return Promise.resolve(matches);
    },
  };
  return { embeddings, searches, deps };
}

const input = { userId: 'user-1', notebookId: 'notebook-1', query: 'What does L2 penalize?' };

describe('retrieve', () => {
  it('embeds the query and searches the notebook with its vector', async () => {
    const { embeddings, searches, deps } = setup();

    await retrieve(input, deps);

    expect(embeddings.calls).toEqual([['What does L2 penalize?']]);
    expect(searches).toEqual([
      {
        userId: 'user-1',
        notebookId: 'notebook-1',
        embedding: fakeVector('What does L2 penalize?'),
        limit: retrieval.vectorCandidates,
      },
    ]);
  });

  it('trims the query before embedding it', async () => {
    const { embeddings, deps } = setup();
    await retrieve({ ...input, query: '  What does L2 penalize?\n' }, deps);
    expect(embeddings.calls).toEqual([['What does L2 penalize?']]);
  });

  it('passes a custom limit through', async () => {
    const { searches, deps } = setup();
    await retrieve({ ...input, limit: 10 }, deps);
    expect(searches[0]?.limit).toBe(10);
  });

  it.each([0, -1, 2.5, Number.NaN])('rejects limit %s without calling anything', async (limit) => {
    const { embeddings, searches, deps } = setup();
    await expect(retrieve({ ...input, limit }, deps)).rejects.toThrow(RangeError);
    expect(embeddings.calls).toEqual([]);
    expect(searches).toEqual([]);
  });

  it('returns nothing for a blank query, without calling the embeddings API', async () => {
    const { embeddings, searches, deps } = setup([match()]);
    expect(await retrieve({ ...input, query: '   ' }, deps)).toEqual([]);
    expect(embeddings.calls).toEqual([]);
    expect(searches).toEqual([]);
  });

  it('keeps the search order, numbers the ranks from 1 and turns distance into a score', async () => {
    const { deps } = setup([
      match({ chunkId: 'a', distance: 0.1 }),
      match({ chunkId: 'b', distance: 0.4, pageNumber: 3 }),
    ]);

    const results = await retrieve(input, deps);

    expect(results.map((r) => [r.rank, r.chunkId])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(results[0]?.score).toBeCloseTo(0.9);
    expect(results[1]?.score).toBeCloseTo(0.6);
  });

  it('groups the location fields and keeps the source details', async () => {
    const { deps } = setup([
      match({
        sourceType: 'YOUTUBE',
        pageNumber: null,
        startSeconds: 60,
        endSeconds: 95,
        headingPath: null,
        charStart: 10,
        charEnd: 80,
      }),
    ]);

    const [result] = await retrieve(input, deps);

    expect(result).toMatchObject({
      sourceId: 'source-1',
      sourceTitle: 'ML notes',
      sourceType: 'YOUTUBE',
      chunkIndex: 0,
      content: 'L2 regularization penalizes large weights.',
      contextHeader: 'ML notes',
      location: {
        pageNumber: null,
        startSeconds: 60,
        endSeconds: 95,
        headingPath: null,
        charStart: 10,
        charEnd: 80,
      },
    });
    expect(result).not.toHaveProperty('distance');
  });

  it('lets an embeddings failure through unchanged', async () => {
    const { embeddings, searches, deps } = setup();
    const failure = IngestionError.transient('down');
    embeddings.failNext(failure);

    await expect(retrieve(input, deps)).rejects.toBe(failure);
    expect(searches).toEqual([]);
  });
});
