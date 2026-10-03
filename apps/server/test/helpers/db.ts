import { neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { createDb } from '../../src/db/client.js';

let connection: ReturnType<typeof createDb> | undefined;

/** A copy taken before setup overwrites `DATABASE_URL` with the test URL. */
let protectedEnv: NodeJS.ProcessEnv = {};

export function rememberProtectedEnv(env: NodeJS.ProcessEnv) {
  protectedEnv = { ...env };
}

/** Env vars that point at databases tests must never touch. */
const PROTECTED_URL_VARS = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'PROD_DATABASE_URL'] as const;

/**
 * Host + database name. Neon's pooled host is the direct host with `-pooler`, and credentials or
 * query params can differ, so comparing raw strings isn't enough.
 */
function databaseIdentity(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/-pooler(?=\.)/, '');
  return `${host}:${parsed.port || '5432'}${parsed.pathname}`;
}

/**
 * Tests truncate every table, so refuse to run unless `TEST_DATABASE_URL` is a different database
 * from dev and production. `env` defaults to the environment as loaded from `.env`.
 */
export function assertSafeTestDatabase(env: NodeJS.ProcessEnv = protectedEnv): string {
  const testUrl = env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL is required to run tests');
  const testIdentity = databaseIdentity(testUrl);
  for (const name of PROTECTED_URL_VARS) {
    const other = env[name];
    if (other && databaseIdentity(other) === testIdentity) {
      throw new Error(
        `TEST_DATABASE_URL points at the same database as ${name}. Tests truncate every table; ` +
          'use the local test database (`pnpm db:test:up`).',
      );
    }
  }
  return testUrl;
}

/** Port of Neon's WebSocket proxy in front of the local test Postgres (docker-compose.yml). */
const LOCAL_WS_PROXY_PORT = 5433;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * The Neon driver speaks WebSocket, not the Postgres wire protocol. For a local `TEST_DATABASE_URL`
 * it goes through the `wsproxy` container, without TLS. Neon URLs are left alone.
 */
function useLocalProxyFor(url: string) {
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) return;
  neonConfig.wsProxy = (host) => `${host}:${LOCAL_WS_PROXY_PORT}/v1`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

export function getTestDb() {
  const url = assertSafeTestDatabase();
  if (!connection) {
    useLocalProxyFor(url);
    connection = createDb(url);
  }
  return connection.db;
}

/** Applies pending migrations to the test database (once per run, from `global-setup.ts`). */
export async function migrateTestDb() {
  const migrationsFolder = new URL('../../src/db/migrations', import.meta.url).pathname;
  await migrate(getTestDb(), { migrationsFolder });
}

/** Empties every table in the public schema (run before each test file). */
export async function truncateAllTables() {
  assertSafeTestDatabase();
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
