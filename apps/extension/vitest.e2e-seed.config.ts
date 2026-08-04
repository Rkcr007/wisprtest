import { defineConfig } from 'vitest/config';

import { WORKSPACE_ALIASES } from './src/build.js';

/**
 * The seeding loop end-to-end (docs/BUILD-PLAN.md Phase 15, `test:e2e:seed`).
 *
 * Its own config, like the command end-to-end, and for the same two reasons: it must not fold into
 * the HUD suite's run, and it needs no `globalSetup` because it does not load the packed extension.
 * It bundles the seeding modules itself and serves them into a real page, so the browser runs the
 * shipping code against an application whose records really appear and disappear.
 *
 * `fileParallelism` is off because the two servers bind fixed ports — a second file would contend
 * for both.
 */
export default defineConfig({
  resolve: { alias: { ...WORKSPACE_ALIASES } },
  test: {
    environment: 'node',
    include: ['test/e2e-seed/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
