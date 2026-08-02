import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The crawl enqueue and index-progress routes, end to end against the Compose Postgres and Redis.
// Its own config — like the memory, db, resolve and sessions suites — so `pnpm test` on a laptop
// with nothing started stays fast and dependency-free. `pnpm --filter gateway test:crawl` is the
// one that needs the stack.
//
// This suite listens on a real ephemeral port rather than using `app.inject`: the progress route
// is a Server-Sent Events stream, and `inject` buffers a response to completion, so a streaming
// endpoint and its disconnect handling cannot be exercised through it at all.
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
    include: ['test/crawl/**/*.test.ts'],
    // One database and one shared job stream: parallel files would interleave.
    fileParallelism: false,
    // A blocking XREAD is budgeted at 15 s, and one test deliberately waits out a quiet stream.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
