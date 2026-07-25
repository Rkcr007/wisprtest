import { defineConfig } from 'vitest/config';

// Loads the built extension into a real Chromium. Kept in its own config so `pnpm test` stays a
// fast, dependency-free unit run — this one needs a browser and a build.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    globalSetup: ['./test/e2e/global-setup.ts'],
    // One browser, one profile, two fixed ports: parallel files would contend for all three.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
