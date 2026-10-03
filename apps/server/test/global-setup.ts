import { closeTestDb, migrateTestDb } from './helpers/db.js';
import { loadTestEnv } from './load-env.js';

// Integration tests only: the test database is always on the latest migration.
export default async function setup() {
  // Workers inherit this process's env, so undo `loadTestEnv`'s overrides afterwards: each worker
  // runs it again and checks the original `DATABASE_URL` against the test URL.
  const original = { ...process.env };
  try {
    loadTestEnv();
    await migrateTestDb();
  } catch (error) {
    throw new Error(
      'Could not migrate the test database. Is it running? Start it with `pnpm db:test:up`.',
      {
        cause: error,
      },
    );
  } finally {
    await closeTestDb();
    process.env = original;
  }
}
