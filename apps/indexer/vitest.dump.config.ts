import { defineConfig } from 'vitest/config';

/**
 * The dump crawl: a real browser against the local fixture app, no Compose.
 *
 * Its own config so `pnpm test` stays a unit suite. `pnpm --filter indexer test:dump` is the
 * command that proves a machine without Docker can still produce a MemorySnapshot.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/dump/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
