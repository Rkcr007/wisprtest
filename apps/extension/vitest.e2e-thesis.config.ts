import { defineConfig } from 'vitest/config';

import { WORKSPACE_ALIASES } from './src/build.js';

/**
 * The thesis bake-off (Remember → Execute on the live fixture app).
 *
 * Its own config, like the other end-to-end suites: it must not fold into the HUD run, and it
 * needs no `globalSetup` because it injects the shipping modules itself rather than loading the
 * packed extension.
 */
export default defineConfig({
  resolve: { alias: { ...WORKSPACE_ALIASES } },
  test: {
    environment: 'node',
    include: ['test/e2e-thesis/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
