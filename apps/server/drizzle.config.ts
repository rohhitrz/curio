import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// `DB_TARGET` picks the Neon branch: dev (default) · test · prod (`main`, run manually only).
const urlVars: Record<string, string> = {
  dev: 'DATABASE_URL',
  test: 'TEST_DATABASE_URL',
  prod: 'PROD_DATABASE_URL',
};
const target = process.env.DB_TARGET ?? 'dev';
const urlVar = urlVars[target];
if (!urlVar) throw new Error(`Unknown DB_TARGET "${target}" (use dev, test, or prod)`);
const url = process.env[urlVar];
if (!url) throw new Error(`${urlVar} is required for DB_TARGET=${target}`);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
