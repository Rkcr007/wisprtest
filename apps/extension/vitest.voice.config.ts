import { defineConfig } from 'vitest/config';

import { WORKSPACE_ALIASES } from './src/build.js';

/**
 * The voice pipeline suite (docs/BUILD-PLAN.md Phase 9).
 *
 * On its own config so `pnpm --filter extension test:voice` runs the whole pipeline — VAD, framer,
 * reconnect, the pipeline state machine, the hotkey, the Deepgram client and the worker controller
 * — against the recorded PCM fixture and the fake `StreamingAsr`, without a microphone or a
 * network. happy-dom supplies the `KeyboardEvent`/`EventTarget` the hotkey test drives and lets the
 * pipeline read `performance.now`.
 */
export default defineConfig({
  resolve: { alias: { ...WORKSPACE_ALIASES } },
  test: {
    environment: 'happy-dom',
    include: ['src/voice/**/*.test.ts', 'src/background/voice-controller.test.ts'],
  },
});
