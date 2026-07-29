import { defineConfig } from 'vitest/config';

import { WORKSPACE_ALIASES } from './src/build.js';

/**
 * The speech-to-reticle benchmark gate (docs/BUILD-PLAN.md Phase 10, CLAUDE.md § "Performance
 * budgets": speech onset → reticle rendered, p95 < 400 ms).
 *
 * On its own config, and deliberately *not* matched by the `src` bench glob, so it does not fold into
 * Phase 7's `bench:scope` run — each gate fails for its own reason. Like the other benches it runs
 * single-threaded: a timing assertion measured while other workers fight for the core measures the
 * runner, not the code. CI wires it as a gate in Phase 19.
 */
export default defineConfig({
  resolve: { alias: { ...WORKSPACE_ALIASES } },
  test: {
    environment: 'happy-dom',
    include: ['test/bench/**/*.bench.ts'],
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
