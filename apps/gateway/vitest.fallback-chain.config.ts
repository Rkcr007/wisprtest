import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The fallback chain, through the real seed routes.
//
// The chaos test docs/BUILD-PLAN.md Phase 16 asks for: force the API adapter to fail and assert
// the chain falls through to UI, the record is still created, and the ledger records both the
// attempt and the fallback. Same stack as the seed suite — Compose Postgres and Redis, a scripted
// composer and a scripted worker — because the thing under test is what the gateway does with a
// failure, and a real browser would only make that slower to arrange.
//
// Its own config rather than another file in `test/seed`, because Phase 16's `Done when` names it
// separately: `pnpm --filter gateway test:fallback-chain`.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url).pathname);
} catch {
  // No .env: fall back to whatever the environment already provides, and let the suite report
  // the missing variable by name.
}

export default defineConfig({
  resolve: {
    alias: {
      // Run the contract against its source, so the suite does not need packages/protocol built.
      // `fingerprint` is left to resolve through its built package: it is a browser package and its
      // source pulls in DOM globals, so — like the indexer — the gateway consumes the built entry.
      protocol: fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/fallback-chain/**/*.test.ts'],
    // One database, shared state, `SET ROLE` per connection: parallel files would interleave.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
