import { describe, expect, it } from 'vitest';
import { assertSafeTestDatabase } from '../helpers/db.js';

const PROD =
  'postgresql://owner:pw@ep-prod-123-pooler.eu-central-1.aws.neon.tech/curio?sslmode=require';
const DEV =
  'postgresql://owner:pw@ep-dev-456-pooler.eu-central-1.aws.neon.tech/curio?sslmode=require';
const TEST =
  'postgresql://owner:pw@ep-test-789-pooler.eu-central-1.aws.neon.tech/curio?sslmode=require';

describe('test database safety check', () => {
  it('a separate test branch passes', () => {
    expect(
      assertSafeTestDatabase({
        TEST_DATABASE_URL: TEST,
        DATABASE_URL: DEV,
        PROD_DATABASE_URL: PROD,
      }),
    ).toBe(TEST);
  });

  it.each([
    ['the production URL', PROD, 'PROD_DATABASE_URL'],
    ['the dev URL', DEV, 'DATABASE_URL'],
    ['prod via the direct (unpooled) host', PROD.replace('-pooler', ''), 'PROD_DATABASE_URL'],
    [
      'prod with other credentials and params',
      PROD.replace('owner:pw', 'x:y').replace('?sslmode=require', ''),
      'PROD_DATABASE_URL',
    ],
    ['prod with an uppercase host', PROD.replace('ep-prod', 'EP-PROD'), 'PROD_DATABASE_URL'],
  ])('TEST_DATABASE_URL = %s → refuses', (_label, testUrl, varName) => {
    expect(() =>
      assertSafeTestDatabase({
        TEST_DATABASE_URL: testUrl,
        DATABASE_URL: DEV,
        PROD_DATABASE_URL: PROD,
      }),
    ).toThrow(`same database as ${varName}`);
  });

  it('missing TEST_DATABASE_URL → refuses', () => {
    expect(() => assertSafeTestDatabase({ DATABASE_URL: DEV })).toThrow(
      'TEST_DATABASE_URL is required',
    );
  });
});
