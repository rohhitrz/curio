import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from '../../src/config/env.js';

const serverDir = fileURLToPath(new URL('../..', import.meta.url));

const validEnv = {
  DATABASE_URL: 'postgresql://user:pw@localhost/db',
  CLERK_SECRET_KEY: 'sk_test_x',
  CLERK_PUBLISHABLE_KEY: 'pk_test_x',
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'curio-test',
  CORS_ORIGINS: 'http://localhost:3000',
  INNGEST_EVENT_KEY: 'event-key',
  INNGEST_SIGNING_KEY: 'signkey-test-abc',
  OPENAI_API_KEY: 'sk-test',
  FIRECRAWL_API_KEY: 'fc-test',
  TRANSCRIPT_API_KEY: 'sd-test',
};

describe('env validation', () => {
  it('lists every missing required var', () => {
    expect(() => loadEnv({})).toThrow(EnvError);
    expect(() => loadEnv({})).toThrow('DATABASE_URL is required');
    expect(() => loadEnv({})).toThrow('CLERK_SECRET_KEY is required');
    expect(() => loadEnv({})).toThrow('R2_ACCOUNT_ID is required');
    expect(() => loadEnv({})).toThrow('R2_SECRET_ACCESS_KEY is required');
    expect(() => loadEnv({})).toThrow('R2_BUCKET is required');
    expect(() => loadEnv({})).toThrow('CORS_ORIGINS is required');
    expect(() => loadEnv({})).toThrow('INNGEST_EVENT_KEY is required');
    expect(() => loadEnv({})).toThrow('INNGEST_SIGNING_KEY is required');
    expect(() => loadEnv({})).toThrow('OPENAI_API_KEY is required');
    expect(() => loadEnv({})).toThrow('FIRECRAWL_API_KEY is required');
    expect(() => loadEnv({})).toThrow('TRANSCRIPT_API_KEY is required');
  });

  it.each(['INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'])(
    '%s missing outside dev mode → refuses to start',
    (name) => {
      for (const dev of [undefined, '0', 'false']) {
        expect(() => loadEnv({ ...validEnv, INNGEST_DEV: dev, [name]: '' })).toThrow(
          `${name} is required (or set INNGEST_DEV=1 to use the local Inngest dev server)`,
        );
      }
    },
  );

  it('INNGEST_DEV=1 → starts without Inngest keys', () => {
    const { INNGEST_EVENT_KEY: _event, INNGEST_SIGNING_KEY: _signing, ...withoutKeys } = validEnv;
    const local = { ...withoutKeys, NODE_ENV: 'development' };
    expect(loadEnv({ ...local, INNGEST_DEV: '1' })).toMatchObject({ INNGEST_DEV: true });
    expect(loadEnv({ ...local, INNGEST_DEV: 'true' })).toMatchObject({ INNGEST_DEV: true });
  });

  it.each([undefined, 'production'])(
    'INNGEST_DEV=1 with NODE_ENV=%s (production) → refuses to start, even with the keys',
    (nodeEnv) => {
      // Dev mode would turn off the signature check on /api/inngest.
      expect(() => loadEnv({ ...validEnv, NODE_ENV: nodeEnv, INNGEST_DEV: '1' })).toThrow(
        'INNGEST_DEV must not be set in production',
      );
      expect(loadEnv({ ...validEnv, NODE_ENV: nodeEnv, INNGEST_DEV: '0' }).INNGEST_DEV).toBe(false);
    },
  );

  it('INNGEST_DEV with an unknown value → refuses to start', () => {
    expect(() => loadEnv({ ...validEnv, INNGEST_DEV: 'yes' })).toThrow('INNGEST_DEV: ');
  });

  it.each([
    ['empty', '', 'CORS_ORIGINS is required'],
    ['only commas', ' , ', 'CORS_ORIGINS: must list at least one origin'],
    ['trailing slash', 'https://app.example.com/', 'CORS_ORIGINS.0: must be an origin'],
    ['a path', 'http://a.test,https://app.example.com/app', 'CORS_ORIGINS.1: must be an origin'],
    ['not a URL', 'localhost:3000', 'CORS_ORIGINS.0: must be an origin'],
  ])('CORS_ORIGINS %s → refuses to start', (_label, value, message) => {
    expect(() => loadEnv({ ...validEnv, CORS_ORIGINS: value })).toThrow(message);
  });

  it('rejects invalid values', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://x', PORT: 'abc' })).toThrow(
      /PORT: [^\n]*\n(.*\n)*.*DATABASE_URL: /,
    );
  });

  it('rejects a malformed R2 account ID', () => {
    expect(() => loadEnv({ ...validEnv, R2_ACCOUNT_ID: 'not-an-id' })).toThrow(
      'R2_ACCOUNT_ID: must be a 32-char hex Cloudflare account ID',
    );
  });

  it('parses valid env with defaults', () => {
    const env = loadEnv({
      ...validEnv,
      CORS_ORIGINS: 'http://a.test, http://b.test',
    });
    expect(env).toMatchObject({
      // Not `development`: that needs the dev-only `pino-pretty` and would crash a real deploy.
      NODE_ENV: 'production',
      PORT: 4000,
      CORS_ORIGINS: ['http://a.test', 'http://b.test'],
      INNGEST_DEV: false,
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
