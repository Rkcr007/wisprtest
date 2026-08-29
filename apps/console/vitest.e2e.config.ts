import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    name: 'e2e',
    environment: 'happy-dom',
    include: ['src/**/*.e2e.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
