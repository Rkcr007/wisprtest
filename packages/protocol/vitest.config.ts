import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      // On by default rather than behind a flag, for the reason given in
      // packages/fingerprint/vitest.config.ts: a gate that only runs when someone remembers
      // `--coverage` is not a gate. This package is the contract every other package is checked
      // against, so a schema that nothing round-trips is a hole in all of them at once.
      enabled: true,
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // `fixtures.ts` is test data and `json-schema.ts` is exercised through the generated
      // bundle rather than directly; `index.ts` is re-exports only.
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/fixtures.ts'],
      // Set just under the measured position (97.3% statements, 84.1% branches, 100% functions,
      // 99.1% lines) rather than at an aspirational round number. These are a ratchet: they lock
      // in what the suite already covers so a new schema cannot land untested, and they are meant
      // to be raised as coverage rises — not to be met one day and decorative thereafter.
      thresholds: {
        statements: 95,
        branches: 82,
        functions: 100,
        lines: 97,
      },
    },
  },
});
