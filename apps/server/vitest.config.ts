import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          // No database: files run in parallel.
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
          setupFiles: ['./test/setup-env.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup-env.ts', './test/setup.ts'],
          // Test files share one test database, so they run one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
});
