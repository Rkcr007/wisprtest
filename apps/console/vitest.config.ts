import { defineConfig } from 'vitest/config';

/**
 * Two suites, because the console has two kinds of code.
 *
 * The server half — config, the OIDC flow, the session cookie, the gateway client, the progress
 * reducer — is plain TypeScript and runs in Node, which is also where it runs in production. The
 * component half needs a DOM and JSX, and uses happy-dom, which is what the rest of the
 * repository already uses (`packages/ui`, `apps/extension`), so there is one DOM implementation
 * to know the quirks of rather than two.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./src/test-setup.ts'],
        },
      },
    ],
  },
});
