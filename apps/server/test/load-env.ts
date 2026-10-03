import { existsSync } from 'node:fs';
import { assertSafeTestDatabase, rememberProtectedEnv } from './helpers/db.js';

/**
 * Loads `.env` and points everything under test at the test database. Shared by `setup-env.ts`
 * (every test file) and `global-setup.ts` (once per run).
 */
export function loadTestEnv() {
  const envFile = new URL('../../../.env', import.meta.url);
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  // Checked against dev and prod before `DATABASE_URL` is overwritten below.
  rememberProtectedEnv(process.env);
  const testUrl = assertSafeTestDatabase();

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testUrl;
  process.env.LOG_LEVEL = 'silent';
}
