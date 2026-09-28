import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from './schema/index.js';

/**
 * Pooled Neon connection (WebSocket driver, so interactive transactions work).
 * Use the pooled connection string (`-pooler` host) in DATABASE_URL.
 */
export function createDb(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
