import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `paths` entry in tsconfig.json: tests run against the contract's source, so
      // the suite does not depend on `packages/protocol` having been built first.
      protocol: fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // Every function in this package takes DOM nodes. happy-dom gives the suite real ones
    // without a browser, which is what lets the fixtures be written as markup.
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    coverage: {
      // On by default rather than behind a flag. docs/BUILD-PLAN.md Phase 2 gates this package
      // on coverage, and a gate that only runs when someone remembers `--coverage` is not a
      // gate. The suite is fast enough that the instrumentation cost does not matter here.
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/testing.ts'],
      // docs/BUILD-PLAN.md Phase 2 gates this package on ≥90% coverage of scoring and resolve.
      // Those two files carry the thresholds explicitly so the gate cannot be met by piling
      // coverage onto easier modules elsewhere in the package.
      thresholds: {
        'src/score.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/resolve.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
