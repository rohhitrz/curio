import { afterAll, beforeAll } from 'vitest';
import { closeTestDb, truncateAllTables } from './helpers/db.js';

// Integration tests only (runs after `setup-env.ts`): every file starts from empty tables.
beforeAll(async () => {
  await truncateAllTables();
});

afterAll(async () => {
  await closeTestDb();
});
