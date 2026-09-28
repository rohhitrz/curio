import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from '../helpers/db.js';

describe('test database', () => {
  it('connects to the Neon test branch with pgvector enabled', async () => {
    const result = await getTestDb().execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'vector'`,
    );

    expect(result.rows).toEqual([{ extname: 'vector' }]);
  });
});
