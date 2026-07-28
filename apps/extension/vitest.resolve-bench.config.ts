import { defineConfig } from 'vitest/config';

import { WORKSPACE_ALIASES } from './src/build.js';

/**
 * The resolution latency gates: T0 p99 < 15 ms with 500 aliases loaded, and T1 within its 40 ms
 * budget (CLAUDE.md § "Resolution tiers" and § "Performance budgets").
 *
 * On its own config, and single-threaded: a latency assertion sharing a core with three other
 * workers measures the runner, not the resolver. Node environment for the same reason as the
 * resolver suite — onnxruntime-web must not detect a happy-dom `window` and take the browser
 * WASM-loading path.
 */
export default defineConfig({
  resolve: { alias: { ...WORKSPACE_ALIASES } },
  test: {
    environment: 'node',
    include: ['test/resolver/**/*.bench.ts'],
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
