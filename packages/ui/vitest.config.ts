import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The primitives are React components rendered into a DOM, so the suite needs both a DOM and
  // JSX. happy-dom rather than jsdom: it is what `packages/fingerprint` already uses, and one
  // DOM implementation across the repo means one set of behaviours to know about.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
