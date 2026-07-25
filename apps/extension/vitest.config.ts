import { defineConfig } from 'vitest/config';

import { WORKSPACE_ALIASES } from './src/build.js';

export default defineConfig({
  // The same source-not-dist mapping the build uses, so a suite can never pass against a stale
  // build of `ui` that the extension itself would never load.
  resolve: { alias: { ...WORKSPACE_ALIASES } },
  // The content script's tests render React into a DOM; the worker's tests do not, but a single
  // environment means one set of behaviours to reason about. happy-dom is what the rest of the
  // repository already uses.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
