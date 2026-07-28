import { defineConfig } from 'vitest/config';

import { WORKSPACE_ALIASES } from './src/build.js';

/**
 * The command end-to-end (docs/BUILD-PLAN.md Phase 10 `test:e2e:command`).
 *
 * Separate from `vitest.e2e.config.ts` so it does not fold into the HUD e2e's run, and needs no
 * `globalSetup`: it does not load the packed extension. It drives the executor's exact CDP command
 * stream through a real Chromium's DevTools protocol, proving those commands produce *trusted*
 * input in a real browser — the property a class-C control is entitled to check.
 */
export default defineConfig({
  resolve: { alias: { ...WORKSPACE_ALIASES } },
  test: {
    environment: 'node',
    include: ['test/e2e-command/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
