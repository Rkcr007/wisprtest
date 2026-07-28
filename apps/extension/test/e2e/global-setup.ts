import { fileURLToPath } from 'node:url';

import { runBuild } from '../../src/build.js';
import { GATEWAY_PORT } from '../fixture-page/server.js';

/**
 * Build the extension the suite is about to load.
 *
 * Built here rather than assumed, because the `host_permissions` in the manifest have to name the
 * stub gateway's origin: the fetch and the permission come from one build parameter, and a suite
 * running against a `dist/` built for some other gateway would fail with a blocked request and no
 * obvious cause.
 *
 * This is also what keeps `pnpm --filter extension test:e2e` working on its own, which is the
 * command in docs/BUILD-PLAN.md.
 */
export default async function setup(): Promise<void> {
  await runBuild({
    outDir: fileURLToPath(new URL('../../dist', import.meta.url)),
    gatewayOrigin: `http://127.0.0.1:${String(GATEWAY_PORT)}`,
    env: 'test',
    version: '0.0.0',
    watch: false,
    // No ASR credential in the e2e build: voice surfaces `no_token` rather than opening a mic a
    // headless Chromium has no device for. The pipeline itself is proven in `test:voice`.
    asrToken: '',
  });
}
