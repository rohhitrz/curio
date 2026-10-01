import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from './schema/index.js';

/**
 * Pooled Neon connection (WebSocket driver, so interactive transactions work).
 * Use the pooled connection string (`-pooler` host) in DATABASE_URL.
 *
 * An idle connection that Neon closes makes the pool emit `error`; without a listener that
 * crashes the process. The pool drops that connection and opens a new one on the next query, so
 * it's only reported (`onIdleError`, default: stderr).
 */
export function createDb(
  databaseUrl: string,
  onIdleError: (error: Error) => void = (error) => {
    console.error('database: idle connection closed', error);
  },
) {
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on('error', onIdleError);
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
