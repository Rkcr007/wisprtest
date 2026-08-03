import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The seed routes, end to end against the Compose Postgres and Redis. The composer and the
// browser are scripted — each for a reason stated in its support module — and everything between
// them is real: the policy the database computes, the plan held in Redis, the job on the stream
// the indexer reads, the ledger row and the audit entry. `pnpm --filter gateway test:seed`.
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
    include: ['test/seed/**/*.test.ts'],
    // One database, shared state, `SET ROLE` per connection: parallel files would interleave.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
