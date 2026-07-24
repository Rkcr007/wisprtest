import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The contract lands in Phase 1. Until then this package has no behaviour to assert,
    // and an empty suite is the honest result rather than a placeholder test.
    passWithNoTests: true,
  },
});
