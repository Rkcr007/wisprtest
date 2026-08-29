import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    name: 'a11y',
    environment: 'happy-dom',
    include: ['src/**/*.a11y.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
