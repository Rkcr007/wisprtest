import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The end-to-end suite: a real browser, a real Express application, the Compose Postgres and
// Redis. Kept in its own config so `pnpm test` — which every workspace package runs, on a laptop
// with nothing started — stays fast and dependency-free.
try {
  // The suite reads DATABASE_URL and REDIS_URL. Loading `.env` here rather than wrapping the
  // script keeps the invocation in docs/BUILD-PLAN.md working verbatim.
  process.loadEnvFile(new URL('../../.env', import.meta.url).pathname);
} catch {
  // No .env: fall back to the ambient environment, and let the harness name what is missing.
}

export default defineConfig({
  resolve: {
    alias: {
      // Run against the contract's source, so the suite does not depend on packages/protocol
      // having been built. The in-page bundle is a separate matter — esbuild resolves
      // `fingerprint` through its package entry, which is why globalSetup builds it.
      protocol: fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    globalSetup: ['./test/e2e/global-setup.ts'],
    // One browser, one database, shared Compose services: parallel files would contend for all
    // three and produce failures that have nothing to do with the code.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
