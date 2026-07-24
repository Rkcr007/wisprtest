import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Fingerprinting and scoring land in Phase 2, together with their happy-dom fixtures.
    passWithNoTests: true,
  },
});
