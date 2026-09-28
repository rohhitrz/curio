import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from '../../src/config/env.js';

const serverDir = fileURLToPath(new URL('../..', import.meta.url));

describe('env validation', () => {
  it('lists every missing required var', () => {
    expect(() => loadEnv({})).toThrow(EnvError);
    expect(() => loadEnv({})).toThrow('DATABASE_URL is required');
    expect(() => loadEnv({})).toThrow('CLERK_SECRET_KEY is required');
  });

  it('rejects invalid values', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://x', PORT: 'abc' })).toThrow(
      /PORT: .*\n.*DATABASE_URL: /,
    );
  });

  it('parses valid env with defaults', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://user:pw@localhost/db',
      CLERK_SECRET_KEY: 'sk_test_x',
      CLERK_PUBLISHABLE_KEY: 'pk_test_x',
      CORS_ORIGINS: 'http://a.test, http://b.test',
    });
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      CORS_ORIGINS: ['http://a.test', 'http://b.test'],
    });
  });

  it('missing required env var → server refuses to start with a clear message', () => {
    const result = spawnSync('npx', ['tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid environment configuration');
    expect(result.stderr).toContain('DATABASE_URL is required');
  });
});
