import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Integration tests that require the Compose Postgres. Kept in their own config so `pnpm test`
// — which every workspace package runs, in CI and on a laptop with nothing started — stays
// fast and dependency-free. `pnpm --filter gateway test:db` is the one that needs a database.
try {
  // The suite reads DATABASE_URL. Loading `.env` here rather than wrapping the script in
  // `node --env-file` keeps the invocation in docs/BUILD-PLAN.md working verbatim.
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
    include: ['test/db/**/*.test.ts'],
    // One database, shared state, `SET ROLE` per connection: parallel files would interleave.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
