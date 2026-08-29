import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemorySnapshot } from 'protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dumpBounds } from '../../src/dump/bounds.js';
import { dumpApplication } from '../../src/dump/run.js';
import { startFixtureApp, type FixtureApp } from '../fixture-app/server.js';

/**
 * The live-loop dump, against the same fixture the thesis bake-off uses.
 *
 * No Postgres, no Redis. If this fails, Remember → Execute has nothing to remember on a
 * machine that cannot run Compose.
 */

let app: FixtureApp | undefined;

beforeAll(async () => {
  app = await startFixtureApp();
}, 30_000);

afterAll(async () => {
  await app?.close();
});

describe('dumpApplication — fixture app, no control plane', () => {
  it('writes a contract-valid snapshot that names Orders and the pending filter', async () => {
    if (app === undefined) throw new Error('fixture app did not start');
    const result = await dumpApplication({
      baseUrl: app.url,
      bounds: dumpBounds({
        origin: new URL(app.url).origin,
        maxDepth: 2,
        maxPages: 12,
        requestsPerMinute: 600,
        neverInteractSelectors: ['[data-testid="order-delete"]', '[data-testid="settings-purge"]'],
      }),
    });

    const parsed = MemorySnapshot.parse(result.snapshot);
    expect(result.summary.screensIndexed).toBeGreaterThanOrEqual(3);
    expect(parsed.screens.some((screen) => screen.routePattern === '/orders')).toBe(true);
    expect(
      parsed.elements.some((element) =>
        element.fingerprint.accessibleNameRedacted.toLowerCase().includes('pending'),
      ),
    ).toBe(true);
    expect(
      parsed.elements.some((element) => element.fingerprint.accessibleNameRedacted === 'Orders'),
    ).toBe(true);

    const dir = await mkdtemp(join(tmpdir(), 'wispr-dump-'));
    const dest = join(dir, 'snapshot.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(dest, JSON.stringify(parsed));
    const roundTrip = MemorySnapshot.parse(JSON.parse(await readFile(dest, 'utf8')));
    expect(roundTrip.screens).toHaveLength(parsed.screens.length);
  }, 60_000);
});
