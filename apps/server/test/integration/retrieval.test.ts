import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  notebooks,
  sourceChunks,
  sources,
  users,
  type NewSourceChunk,
} from '../../src/db/schema/index.js';
import { chatTimeouts, retrieval, type RetrievalFlags } from '../../src/config/index.js';
import { runRetrieval } from '../../src/pipelines/retrieval/pipeline.js';
import { retrieve } from '../../src/pipelines/retrieval/retrieve.js';
import {
  createRetrievalRepository,
  nearestChunks,
  type HnswIterativeScan,
} from '../../src/repositories/retrieval.repository.js';
import { createFakeEmbeddings, fakeVector } from '../fakes/embeddings.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const db = getTestDb();
const allFlagsOff: RetrievalFlags = {
  queryRewrite: false,
  hybridSearch: false,
  rerank: false,
  subQueries: false,
  relevanceGate: false,
  hyde: false,
};
const repository = createRetrievalRepository(db);

type SourceStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

async function seedUser(clerkUserId: string) {
  const [user] = await db.insert(users).values({ clerkUserId }).returning();
  if (!user) throw new Error('user not created');
  return user;
}

async function seedNotebook(userId: string, title = 'ML') {
  const [notebook] = await db
    .insert(notebooks)
    .values({ userId, title, kind: 'SOURCE' })
    .returning();
  if (!notebook) throw new Error('notebook not created');
  return notebook;
}

let sourceCounter = 0;

/** A source with one chunk per text; each chunk's vector is `vectorFor(text)`. */
async function seedSource(
  notebook: { id: string; userId: string },
  texts: string[],
  options: {
    status?: SourceStatus;
    title?: string;
    vectorFor?: (text: string) => number[];
    chunk?: Partial<NewSourceChunk>;
  } = {},
) {
  sourceCounter += 1;
  const [source] = await db
    .insert(sources)
    .values({
      notebookId: notebook.id,
      userId: notebook.userId,
      type: 'TEXT',
      title: options.title ?? `Source ${String(sourceCounter)}`,
      status: options.status ?? 'READY',
      contentHash: `hash-${String(sourceCounter)}`,
    })
    .returning();
  if (!source) throw new Error('source not created');
  const vectorFor = options.vectorFor ?? ((text: string) => fakeVector(text));
  await db.insert(sourceChunks).values(
    texts.map((text, chunkIndex) => ({
      sourceId: source.id,
      notebookId: notebook.id,
      chunkIndex,
      content: text,
      contextHeader: source.title,
      embedding: vectorFor(text),
      tokenCount: 5,
      ...options.chunk,
    })),
  );
  return source;
}

/** A unit vector close to `base`: mostly `base`, a little of a text's own noise. */
function near(base: number[], text: string, noise = 0.2): number[] {
  const own = fakeVector(text);
  const mixed = base.map((value, i) => value + noise * (own[i] ?? 0));
  const norm = Math.hypot(...mixed);
  return mixed.map((value) => value / norm);
}

beforeEach(async () => {
  await truncateAllTables();
});

describe('vector search (retrieval repository)', () => {
  it('returns the notebook’s chunks nearest first, with their source and location', async () => {
    const user = await seedUser('user_retrieval');
    const notebook = await seedNotebook(user.id);
    const source = await seedSource(notebook, ['alpha', 'beta', 'gamma'], {
      title: 'Greek letters',
      chunk: { pageNumber: 4, charStart: 0, charEnd: 5 },
    });

    const rows = await repository.vectorSearch({
      userId: user.id,
      notebookId: notebook.id,
      embedding: fakeVector('beta'),
      limit: 10,
    });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      sourceId: source.id,
      sourceTitle: 'Greek letters',
      sourceType: 'TEXT',
      chunkIndex: 1,
      content: 'beta',
      contextHeader: 'Greek letters',
      pageNumber: 4,
      startSeconds: null,
      endSeconds: null,
      headingPath: null,
      charStart: 0,
      charEnd: 5,
    });
    expect(rows[0]?.distance).toBeCloseTo(0, 5);
    const distances = rows.map((row) => row.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it('respects the limit', async () => {
    const user = await seedUser('user_retrieval');
    const notebook = await seedNotebook(user.id);
    await seedSource(notebook, ['a', 'b', 'c', 'd', 'e']);

    const rows = await repository.vectorSearch({
      userId: user.id,
      notebookId: notebook.id,
      embedding: fakeVector('a'),
      limit: 2,
    });

    expect(rows).toHaveLength(2);
  });

  it('only searches READY sources', async () => {
    const user = await seedUser('user_retrieval');
    const notebook = await seedNotebook(user.id);
    await seedSource(notebook, ['ready chunk'], { status: 'READY' });
    // A failed reprocess keeps its old chunks; pending/processing sources may have them too.
    for (const status of ['PENDING', 'PROCESSING', 'FAILED'] as const) {
      await seedSource(notebook, [`${status} chunk`], { status });
    }

    const rows = await repository.vectorSearch({
      userId: user.id,
      notebookId: notebook.id,
      embedding: fakeVector('FAILED chunk'),
      limit: 10,
    });

    expect(rows.map((row) => row.content)).toEqual(['ready chunk']);
  });

  it('only searches the given notebook', async () => {
    const user = await seedUser('user_retrieval');
    const notebook = await seedNotebook(user.id, 'ML');
    const other = await seedNotebook(user.id, 'History');
    await seedSource(notebook, ['in this notebook']);
    await seedSource(other, ['in the other notebook']);

    const rows = await repository.vectorSearch({
      userId: user.id,
      notebookId: notebook.id,
      embedding: fakeVector('in the other notebook'),
      limit: 10,
    });

    expect(rows.map((row) => row.content)).toEqual(['in this notebook']);
  });

  it('finds nothing in another user’s notebook', async () => {
    const owner = await seedUser('user_owner');
    const stranger = await seedUser('user_stranger');
    const notebook = await seedNotebook(owner.id);
    await seedSource(notebook, ['private chunk']);

    const rows = await repository.vectorSearch({
      userId: stranger.id,
      notebookId: notebook.id,
      embedding: fakeVector('private chunk'),
      limit: 10,
    });

    expect(rows).toEqual([]);
  });

  it('keeps scanning the HNSW index until the notebook has enough results (iterative scan)', async () => {
    const user = await seedUser('user_retrieval');
    const target = await seedNotebook(user.id, 'Target');
    const crowded = await seedNotebook(user.id, 'Crowded');
    const query = fakeVector('query');

    // 100 chunks elsewhere sit right next to the query; the target notebook's 5 are far away.
    // The index's first `ef_search` (40) candidates all belong to the other notebook.
    await seedSource(
      crowded,
      Array.from({ length: 100 }, (_, i) => `crowded ${String(i)}`),
      { vectorFor: (text) => near(query, text) },
    );
    await seedSource(
      target,
      Array.from({ length: 5 }, (_, i) => `target ${String(i)}`),
    );

    /** Same query as the repository, with the planner pushed onto the HNSW index. */
    const searchWithIndex = (iterativeScan: HnswIterativeScan) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('enable_seqscan', 'off', true)`);
        await tx.execute(sql`select set_config('enable_sort', 'off', true)`);
        const plan = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`explain select id from source_chunks
                order by embedding <=> ${JSON.stringify(query)}::vector limit 5`,
        );
        const usesHnsw = plan.rows.some((row) =>
          row['QUERY PLAN'].includes('source_chunks_embedding_idx'),
        );
        const rows = await nearestChunks(
          tx,
          { userId: user.id, notebookId: target.id, embedding: query, limit: 5 },
          iterativeScan,
        );
        return { usesHnsw, rows };
      });

    const withoutIterativeScan = await searchWithIndex('off');
    const withIterativeScan = await searchWithIndex('strict_order');

    // Proves the test really exercises the index: without iterative scan, the filter drops the
    // index's candidates and the target notebook comes back short.
    expect(withoutIterativeScan.usesHnsw).toBe(true);
    expect(withoutIterativeScan.rows.length).toBeLessThan(5);

    expect(withIterativeScan.rows).toHaveLength(5);
    expect(withIterativeScan.rows.every((row) => row.content.startsWith('target'))).toBe(true);
    const distances = withIterativeScan.rows.map((row) => row.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it('turns the iterative scan on by default and leaves no setting behind', async () => {
    const user = await seedUser('user_retrieval');
    const notebook = await seedNotebook(user.id);
    await seedSource(notebook, ['alpha']);

    const setting = await db.transaction(async (tx) => {
      await nearestChunks(tx, {
        userId: user.id,
        notebookId: notebook.id,
        embedding: fakeVector('alpha'),
        limit: 1,
      });
      // Compared as durations: Postgres prints 5000 ms as "5s".
      const result = await tx.execute<{ value: string; timeout: boolean }>(
        sql`select current_setting('hnsw.iterative_scan') as value,
                   current_setting('statement_timeout')::interval
                     = make_interval(secs => ${chatTimeouts.searchStatementMs / 1000}) as timeout`,
      );
      return result.rows[0];
    });
    expect(setting).toEqual({ value: 'strict_order', timeout: true });

    // `SET LOCAL` ends with the transaction. (The vector literal loads pgvector, which defines the
    // setting, in case this query lands on a fresh pooled connection.)
    const after = await db.execute<{ value: string }>(
      sql`select current_setting('hnsw.iterative_scan') as value, '[1]'::vector as loaded`,
    );
    expect(after.rows[0]?.value).toBe('off');
    const timeout = await db.execute<{ leaked: boolean }>(
      sql`select current_setting('statement_timeout')::interval
               = make_interval(secs => ${chatTimeouts.searchStatementMs / 1000}) as leaked`,
    );
    expect(timeout.rows[0]?.leaked).toBe(false);
  });
});

describe('keyword search (retrieval repository)', () => {
  async function setupNotebook() {
    const user = await seedUser('user_keyword');
    const notebook = await seedNotebook(user.id);
    return { user, notebook };
  }

  const search = (userId: string, notebookId: string, query: string, limit = 10) =>
    repository.keywordSearch({ userId, notebookId, query, limit });

  it('matches stemmed words, ranks chunks that match more of them first', async () => {
    const { user, notebook } = await setupNotebook();
    const source = await seedSource(
      notebook,
      [
        'L2 regularization penalizes large weights.',
        'Regularization reduces overfitting.',
        'Transformers use attention.',
      ],
      { title: 'Notes', chunk: { pageNumber: 2 } },
    );

    const rows = await search(user.id, notebook.id, 'What does L2 regularization penalize?');

    // Any word matches (OR); "penalize" matches "penalizes" by stem.
    expect(rows.map((row) => row.content)).toEqual([
      'L2 regularization penalizes large weights.',
      'Regularization reduces overfitting.',
    ]);
    expect(rows[0]).toMatchObject({ sourceId: source.id, sourceTitle: 'Notes', pageNumber: 2 });
    expect(rows[0]?.textRank).toBeGreaterThan(rows[1]?.textRank ?? Infinity);
  });

  it('finds exact terms and numbers', async () => {
    const { user, notebook } = await setupNotebook();
    await seedSource(notebook, ['We used warmup_steps = 4000.', 'Adam with β2 = 0.98.']);

    expect((await search(user.id, notebook.id, 'β2 0.98')).map((r) => r.content)).toEqual([
      'Adam with β2 = 0.98.',
    ]);
    expect((await search(user.id, notebook.id, '4000')).map((r) => r.content)).toEqual([
      'We used warmup_steps = 4000.',
    ]);
  });

  it('searches the context header too', async () => {
    const { user, notebook } = await setupNotebook();
    await seedSource(notebook, ['Some passage.'], { title: 'Dropout paper' });
    expect(await search(user.id, notebook.id, 'dropout')).toHaveLength(1);
  });

  it('a query of only stop words or punctuation matches nothing', async () => {
    const { user, notebook } = await setupNotebook();
    await seedSource(notebook, ['the and of a']);
    expect(await search(user.id, notebook.id, 'the of a')).toEqual([]);
    expect(await search(user.id, notebook.id, '?!')).toEqual([]);
  });

  it('treats query syntax as plain text', async () => {
    const { user, notebook } = await setupNotebook();
    await seedSource(notebook, ['dropout rate']);
    expect(await search(user.id, notebook.id, "dropout & !rate | ' ( :*")).toHaveLength(1);
  });

  it('respects the limit', async () => {
    const { user, notebook } = await setupNotebook();
    await seedSource(notebook, ['dropout one', 'dropout two', 'dropout three']);
    expect(await search(user.id, notebook.id, 'dropout', 2)).toHaveLength(2);
  });

  it('only searches READY sources in the given notebook of the given user', async () => {
    const { user, notebook } = await setupNotebook();
    const other = await seedNotebook(user.id, 'Other');
    const bob = await seedUser('user_bob_keyword');
    const bobs = await seedNotebook(bob.id);
    await seedSource(notebook, ['dropout ready']);
    await seedSource(notebook, ['dropout failed'], { status: 'FAILED' });
    await seedSource(notebook, ['dropout processing'], { status: 'PROCESSING' });
    await seedSource(other, ['dropout other notebook']);
    await seedSource(bobs, ['dropout bob']);

    expect((await search(user.id, notebook.id, 'dropout')).map((r) => r.content)).toEqual([
      'dropout ready',
    ]);
    expect(await search(user.id, bobs.id, 'dropout')).toEqual([]);
  });
});

describe('retrieve (pipeline + repository)', () => {
  it('embeds the question and returns the matching chunk first, with rank and score', async () => {
    const user = await seedUser('user_retrieval');
    const notebook = await seedNotebook(user.id);
    await seedSource(notebook, [
      'Gradient descent minimizes the loss.',
      'Dropout reduces overfitting.',
      'L2 regularization penalizes large weights.',
    ]);
    const fake = createFakeEmbeddings();

    const results = await retrieve(
      {
        userId: user.id,
        notebookId: notebook.id,
        query: 'Dropout reduces overfitting.',
        limit: 2,
      },
      {
        embeddings: fake.provider,
        vectorSearch: (params) => repository.vectorSearch(params),
      },
    );

    expect(fake.calls).toEqual([['Dropout reduces overfitting.']]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ rank: 1, content: 'Dropout reduces overfitting.' });
    expect(results[0]?.score).toBeCloseTo(1, 5);
    expect(results[1]?.rank).toBe(2);
    expect(results[1]?.score).toBeLessThan(results[0]?.score ?? 0);
  });

  it('hybrid search: keyword search brings in an exact term that vector search misses', async () => {
    const user = await seedUser('user_retrieval');
    const notebook = await seedNotebook(user.id);
    const query = 'How many warmup_steps?';
    const queryVector = fakeVector(query);
    // More filler than vector search returns, all close to the query's vector.
    const fillers = Array.from(
      { length: retrieval.vectorCandidates + 1 },
      (_, i) => `filler passage ${String(i)}`,
    );
    await seedSource(notebook, fillers, { vectorFor: (text) => near(queryVector, text) });
    await seedSource(notebook, ['We trained with warmup_steps = 4000.']);

    const run = (hybridSearch: boolean) =>
      runRetrieval(
        { userId: user.id, notebookId: notebook.id, question: query, history: [], topK: 5 },
        {
          flags: { ...allFlagsOff, hybridSearch },
          embeddings: createFakeEmbeddings().provider,
          vectorSearch: (params) => repository.vectorSearch(params),
          keywordSearch: (params) => repository.keywordSearch(params),
        },
      );

    const vectorOnly = await run(false);
    expect(vectorOnly.chunks.map((c) => c.content)).not.toContain(
      'We trained with warmup_steps = 4000.',
    );

    const hybrid = await run(true);
    expect(hybrid.steps).toMatchObject({ keyword: true, fusion: true });
    // Rank 1 in the keyword list ties with the vector list's rank 1, which comes first.
    expect(hybrid.chunks[1]?.content).toBe('We trained with warmup_steps = 4000.');
  });
});
