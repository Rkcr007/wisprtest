import { defineConfig } from 'vitest/config';

// The three adapters and the chain that orders them, as pure decisions. No database, no Redis, no
// browser: what is under test here is which adapter may run, what the observed payload gets filled
// with, and what an attempt proves about the materializer behind it.
//
// The requests themselves are tested where they are made — `apps/indexer/test/e2e/seed.test.ts`
// drives a real form and replays a real create against a real application — and the whole chain is
// tested through the routes by `test:fallback-chain`. Repeating either here would be slower copies
// of tests that already exist. `pnpm --filter gateway test:materializers`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/materializers/**/*.test.ts'],
  },
});
