import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The memory endpoints, end to end against the Compose Postgres and Redis. Kept in its own
// config — like `vitest.db.config.ts` — so `pnpm test` on a laptop with nothing started stays
// fast and dependency-free. `pnpm --filter gateway test:memory` is the one that needs the stack.
try {
  // The suite reads DATABASE_URL and REDIS_URL. Loading `.env` here rather than wrapping the
  // script keeps the invocation in docs/BUILD-PLAN.md working verbatim.
  process.loadEnvFile(new URL('../../.env', import.meta.url).pathname);
} catch {
  // No .env: fall back to whatever the environment already provides, and let the suite report
  // the missing variable by name.
}

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `paths` entry in tsconfig.json, so the suite runs against the contract's
      // source and does not depend on packages/protocol having been built.
      protocol: fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/memory/**/*.test.ts'],
    // One database, shared state, `SET ROLE` per connection: parallel files would interleave.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
