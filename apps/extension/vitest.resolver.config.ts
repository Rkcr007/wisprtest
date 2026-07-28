import { defineConfig } from 'vitest/config';

import { WORKSPACE_ALIASES } from './src/build.js';

/**
 * The end-to-end resolver suite, on its own config.
 *
 * It loads the real ~33 MB bge-small ONNX model and runs it through onnxruntime-web, so it is
 * kept out of the default unit run — `pnpm test` stays fast and needs no model. `pnpm --filter
 * extension test:resolver` is the one that fetches the model (once) and exercises T0 and T1
 * against the Phase 5 fixture application.
 *
 * The environment is `node`, not happy-dom: onnxruntime-web selects its host by feature-detecting
 * `window`, and a happy-dom global would push it onto the browser WASM-loading path, which cannot
 * read the model off the filesystem. The DOM the test needs is created explicitly with a happy-dom
 * `Window`, so the fixture pages are fingerprinted by the same code the extension runs while
 * onnxruntime stays in its Node mode.
 */
export default defineConfig({
  resolve: { alias: { ...WORKSPACE_ALIASES } },
  test: {
    environment: 'node',
    include: ['test/resolver/**/*.test.ts'],
    // Loading and running a real transformer model outlasts the 5 s default; a timeout here would
    // report as a failure rather than as a cold model load.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One inference session, shared state: parallel files would contend for the WASM runtime.
    fileParallelism: false,
  },
});
