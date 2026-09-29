import { existsSync } from 'node:fs';
import { afterAll, beforeAll } from 'vitest';
import {
  assertSafeTestDatabase,
  closeTestDb,
  rememberProtectedEnv,
  truncateAllTables,
} from './helpers/db.js';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Checked against dev and prod before `DATABASE_URL` is overwritten below.
rememberProtectedEnv(process.env);
const testUrl = assertSafeTestDatabase();

// Everything under test uses the `test` branch only.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testUrl;
process.env.LOG_LEVEL = 'silent';

beforeAll(async () => {
  await truncateAllTables();
});

afterAll(async () => {
  await closeTestDb();
});
