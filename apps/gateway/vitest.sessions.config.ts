import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The session routes, end to end against the Compose Postgres and Redis, with an in-memory
// evidence store injected so the suite needs no bucket and leaves nothing behind. Its own config —
// like the memory, db and resolve suites — so `pnpm test` on a laptop with nothing started stays
// fast and dependency-free. `pnpm --filter gateway test:sessions` is the one that needs the stack.
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
    include: ['test/sessions/**/*.test.ts'],
    // One database, shared state, `SET ROLE` per connection: parallel files would interleave.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
