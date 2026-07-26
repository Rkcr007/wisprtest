import { defineConfig } from 'vitest/config';

import { WORKSPACE_ALIASES } from './src/build.js';

/**
 * The benchmark gates, on their own config.
 *
 * Separate from `vitest.config.ts` for two reasons. A latency assertion inside the unit suite
 * makes `pnpm test` fail for reasons that have nothing to do with the change under review, which
 * is how teams learn to rerun red builds instead of reading them. And these need a serial,
 * single-threaded runner: measuring one thread's work while three others compete for the same
 * core measures the runner, not the code.
 *
 * CI runs this as its own step (docs/BUILD-PLAN.md Phase 19 wires it as a gate alongside
 * speech-to-reticle and T0 resolution).
 */
export default defineConfig({
  resolve: { alias: { ...WORKSPACE_ALIASES } },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.bench.ts'],
    // One file at a time, one thread. Parallel workers on a shared CPU turn a timing assertion
    // into a coin flip.
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    // Building a 3000-node page and running 70 iterations of three scenarios outlasts the
    // default 5s, and a timeout here would report as a failure rather than as a slow machine.
    testTimeout: 60_000,
  },
});
