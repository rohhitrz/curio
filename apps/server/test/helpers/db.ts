import { sql } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';

let connection: ReturnType<typeof createDb> | undefined;

export function getTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  connection ??= createDb(url);
  return connection.db;
}

/** Empties every table in the public schema (run before each test file). */
export async function truncateAllTables() {
  const db = getTestDb();
  const result = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const tables = result.rows.map((row) => `"public"."${row.tablename}"`);
  if (tables.length === 0) return;
  await db.execute(sql.raw(`truncate table ${tables.join(', ')} restart identity cascade`));
}

export async function closeTestDb() {
  if (!connection) return;
  await connection.pool.end();
  connection = undefined;
}
