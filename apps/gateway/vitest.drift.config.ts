import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The drift routes, end to end against the Compose Postgres and Redis.
//
// docs/BUILD-PLAN.md Phase 17's gateway half: raising a report, listing the review queue, and a
// human deciding. The indexer is scripted — a reconcile opens a browser for tens of seconds and
// what is under test here is what the gateway does with the result, not how the result is
// produced — and everything else is real: row-level security, the dedupe, the reconcile job on
// the stream the indexer reads, the memory version flip inside one transaction, the alias
// migration, the audit rows. `pnpm --filter gateway test:drift`.
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
    include: ['test/drift/**/*.test.ts'],
    // One database, shared state, `SET ROLE` per connection: parallel files would interleave.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
