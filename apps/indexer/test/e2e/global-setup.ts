import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Make sure the shared fingerprint package is built before the crawl needs it.
 *
 * The in-page collector is bundled by esbuild, which resolves `fingerprint` through the package's
 * entry point — `dist/index.js`. In a fresh checkout that file does not exist yet, and the
 * failure surfaces from inside a browser injection, which is a long way from the cause.
 *
 * Building it here rather than declaring a `pretest` script keeps
 * `pnpm --filter indexer test:e2e` — the command in docs/BUILD-PLAN.md — working on its own.
 */
export default async function setup(): Promise<void> {
  const entry = new URL('../../../../packages/fingerprint/dist/index.js', import.meta.url);
  if (existsSync(entry)) return;

  await run('pnpm', ['--filter', 'fingerprint', 'build'], {
    cwd: new URL('../../../../', import.meta.url).pathname,
  });
}
