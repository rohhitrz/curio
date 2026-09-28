import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// `DB_TARGET=test` points drizzle-kit at the Neon `test` branch.
const url =
  process.env.DB_TARGET === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    `${process.env.DB_TARGET === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is required`,
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
