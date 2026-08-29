import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Register-application and extension-token mint, against Compose. Own config so `pnpm test`
// on a laptop with nothing started stays the unit run.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url).pathname);
} catch {
  // No .env: fall back to the environment, and let the suite name the missing variable.
}

export default defineConfig({
  resolve: {
    alias: {
      protocol: fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/applications/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
