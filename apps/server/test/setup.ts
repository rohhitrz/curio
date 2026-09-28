import { existsSync } from 'node:fs';
import { afterAll, beforeAll } from 'vitest';
import { closeTestDb, truncateAllTables } from './helpers/db.js';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL is required to run tests');
if (testUrl === process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must point at the Neon `test` branch, not the dev database');
}

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
