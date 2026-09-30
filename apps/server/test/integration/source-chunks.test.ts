import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { embeddings } from '../../src/config/index.js';
import {
  notebooks,
  sourceChunks,
  sources,
  users,
  type NewSourceChunk,
} from '../../src/db/schema/index.js';
import { fakeVector } from '../fakes/embeddings.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';

const db = getTestDb();

async function seedSource() {
  const [user] = await db.insert(users).values({ clerkUserId: 'user_chunks' }).returning();
  if (!user) throw new Error('user not created');
  const [notebook] = await db
    .insert(notebooks)
    .values({ userId: user.id, title: 'ML', kind: 'SOURCE' })
    .returning();
  if (!notebook) throw new Error('notebook not created');
  const [source] = await db
    .insert(sources)
    .values({
      notebookId: notebook.id,
      userId: user.id,
      type: 'TEXT',
      title: 'Notes',
      contentHash: 'hash',
    })
    .returning();
  if (!source) throw new Error('source not created');
  return { notebook, source };
}

function chunk(
  seed: Awaited<ReturnType<typeof seedSource>>,
  chunkIndex: number,
  content: string,
  extra: Partial<NewSourceChunk> = {},
): NewSourceChunk {
  return {
    sourceId: seed.source.id,
    notebookId: seed.notebook.id,
    chunkIndex,
    content,
    contextHeader: 'Notes › Optimizers',
    embedding: fakeVector(content),
    tokenCount: 5,
    ...extra,
  };
}

beforeEach(async () => {
  await truncateAllTables();
});

describe('source_chunks', () => {
  it('stores a chunk with its embedding and location, and reads the vector back', async () => {
    const seed = await seedSource();
    const values = chunk(seed, 0, 'Gradient descent minimizes the loss.', {
      pageNumber: 3,
      startSeconds: 12,
      endSeconds: 40,
      headingPath: 'Optimizers',
      charStart: 10,
      charEnd: 46,
    });

    const [row] = await db.insert(sourceChunks).values(values).returning();

    expect(row).toMatchObject({
      chunkIndex: 0,
      content: 'Gradient descent minimizes the loss.',
      pageNumber: 3,
      startSeconds: 12,
      endSeconds: 40,
      headingPath: 'Optimizers',
      charStart: 10,
      charEnd: 46,
    });
    expect(row?.embedding).toHaveLength(embeddings.dimensions);
    expect(row?.embedding[0]).toBeCloseTo(values.embedding[0] ?? NaN, 5);
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('builds the keyword index from the context header and the content', async () => {
    const seed = await seedSource();
    await db
      .insert(sourceChunks)
      .values([
        chunk(seed, 0, 'Gradient descent minimizes the loss.'),
        chunk(seed, 1, 'Dropout reduces overfitting.', { contextHeader: 'Notes › Regularization' }),
      ]);

    const search = (query: string) =>
      db
        .select({ chunkIndex: sourceChunks.chunkIndex })
        .from(sourceChunks)
        .where(sql`${sourceChunks.searchVector} @@ plainto_tsquery('english', ${query})`)
        .orderBy(sourceChunks.chunkIndex);

    // Stemmed match in the content.
    expect(await search('minimize')).toEqual([{ chunkIndex: 0 }]);
    // A word that is only in the context header.
    expect(await search('regularization')).toEqual([{ chunkIndex: 1 }]);
    expect(await search('optimizers')).toEqual([{ chunkIndex: 0 }]);
  });

  it('finds the nearest chunk by cosine distance', async () => {
    const seed = await seedSource();
    const texts = ['alpha', 'beta', 'gamma'];
    await db.insert(sourceChunks).values(texts.map((text, index) => chunk(seed, index, text)));

    const query = JSON.stringify(fakeVector('beta'));
    const result = await db.execute<{ content: string; distance: number }>(
      sql`select content, embedding <=> ${query}::vector as distance
            from source_chunks
           where notebook_id = ${seed.notebook.id}
           order by distance
           limit 1`,
    );

    expect(result.rows[0]?.content).toBe('beta');
    expect(Number(result.rows[0]?.distance)).toBeCloseTo(0, 5);
  });

  it('the same chunk index twice for one source is rejected', async () => {
    const seed = await seedSource();
    await db.insert(sourceChunks).values(chunk(seed, 0, 'one'));

    await expect(db.insert(sourceChunks).values(chunk(seed, 0, 'again'))).rejects.toThrow();
  });

  it('an embedding with the wrong number of dimensions is rejected', async () => {
    const seed = await seedSource();

    await expect(
      db.insert(sourceChunks).values(chunk(seed, 0, 'short', { embedding: [0.1, 0.2, 0.3] })),
    ).rejects.toThrow();
  });

  it('deleting the source deletes its chunks', async () => {
    const seed = await seedSource();
    await db.insert(sourceChunks).values([chunk(seed, 0, 'one'), chunk(seed, 1, 'two')]);

    await db.delete(sources).where(eq(sources.id, seed.source.id));

    expect(await db.select().from(sourceChunks)).toEqual([]);
  });

  it('has the HNSW, GIN and notebook indexes', async () => {
    const result = await db.execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes where tablename = 'source_chunks'`,
    );
    const definitions = Object.fromEntries(result.rows.map((r) => [r.indexname, r.indexdef]));

    expect(definitions.source_chunks_embedding_idx).toContain('USING hnsw');
    expect(definitions.source_chunks_embedding_idx).toContain('vector_cosine_ops');
    expect(definitions.source_chunks_search_vector_idx).toContain('USING gin');
    expect(definitions.source_chunks_notebook_id_idx).toContain('(notebook_id)');
  });
});
