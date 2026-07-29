import { defineConfig } from 'vitest/config';

import { WORKSPACE_ALIASES } from './src/build.js';

/**
 * The compounding-loop suite, on its own config.
 *
 * It stands up a real HTTP server and drives the escalation, write-back and snapshot clients
 * against it, so the environment is `node` rather than happy-dom: `fetch` must be the platform's,
 * and the DOM the fingerprints come from is created explicitly with a happy-dom `Window` instead —
 * the same split `vitest.resolver.config.ts` uses for onnxruntime.
 */
export default defineConfig({
  resolve: { alias: { ...WORKSPACE_ALIASES } },
  test: {
    environment: 'node',
    include: ['test/writeback-loop/**/*.test.ts'],
    // One server, one alias store: parallel files would answer each other's requests.
    fileParallelism: false,
  },
});
