import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { BrowserError } from '../errors.js';

/**
 * Ships `packages/fingerprint` into the page under test.
 *
 * CLAUDE.md rule #4: fingerprint logic has exactly one implementation, shared verbatim by the
 * extension and the indexer. The extension satisfies that by importing the package; the indexer
 * has a browser between it and the DOM, so it satisfies it by *bundling the same package* and
 * injecting it. The alternative — extracting the DOM into Node and fingerprinting it there —
 * would need a second implementation of computed roles, layout geometry and accessible names,
 * which is precisely the drift rule #4 exists to prevent.
 *
 * The bundle is built once per process and reused for every page of every job. esbuild compiles
 * the TypeScript directly, so there is no separate build artifact to keep in step and no chance
 * of injecting a stale copy.
 *
 * @see in-page/collect.ts — the entry point, and the only DOM-touching code in this service.
 */

/** The global the bundle installs itself on, and the attribute it stamps on collected elements. */
export const BUNDLE_GLOBAL = '__wisprIndexer';
export const MARKER_ATTRIBUTE = 'data-wispr-el';

let cached: Promise<string> | undefined;

/**
 * The injectable IIFE source, built on first use and cached for the process lifetime.
 *
 * Injection is `addInitScript`, so it runs before the page's own scripts on every document —
 * including after a client-side navigation — and the collector is always present without a
 * per-page round trip.
 */
export function fingerprintBundle(): Promise<string> {
  cached ??= buildBundle();
  return cached;
}

async function buildBundle(): Promise<string> {
  const entryPoint = locateEntry();

  const result = await buildOrExplain(entryPoint);

  const [output] = result.outputFiles;
  if (output === undefined) {
    throw new BrowserError('esbuild produced no output for the in-page collector');
  }
  return output.text;
}

/**
 * Run the bundle, translating the one failure that is not a bug in this repository.
 *
 * `fingerprint` resolves through its package entry, which is `dist`. In a checkout where that
 * package has not been built, esbuild reports an unresolved import — accurate, and useless
 * unless you already know the workspace layout.
 */
async function buildOrExplain(entryPoint: string): Promise<{ outputFiles: { text: string }[] }> {
  try {
    return await build({
      entryPoints: [entryPoint],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: BUNDLE_GLOBAL,
      // Playwright wraps an init script in a function, so the `var` esbuild emits for the global
      // name is function-scoped and never reaches the page's global object. The footer publishes
      // it explicitly. (esbuild's own dotted-`globalName` support does not help: it emits
      // `var globalThis; (globalThis ||= {})…`, which shadows the real global inside that same
      // wrapper and assigns the collector to an object nothing can see.)
      footer: { js: `;globalThis.${BUNDLE_GLOBAL} = ${BUNDLE_GLOBAL};` },
      // The crawl runs in a browser we launched ourselves, one version, no legacy target to
      // support. Anything lower would only make the injected source harder to read in a debugger.
      target: 'chrome120',
      platform: 'browser',
      // Bundled code runs in a customer's page; a sourcemap comment pointing at paths on the
      // indexer's filesystem has no reader there.
      sourcemap: false,
      // Minifying would make an exception thrown inside the page unreadable in the crawl log,
      // and the bundle is injected over a local CDP connection where its size is irrelevant.
      minify: false,
      logLevel: 'silent',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Could not resolve "fingerprint"')) {
      throw new BrowserError(
        'packages/fingerprint has not been built — run `pnpm --filter fingerprint build`',
        { cause: error },
      );
    }
    throw new BrowserError(`could not bundle the in-page collector: ${message}`, { cause: error });
  }
}

/**
 * Locate `in-page/collect.ts` relative to this module.
 *
 * The in-page sources are copied into `dist` as TypeScript rather than compiled (see the
 * `build` script), because esbuild is the only compiler that needs to read them and keeping one
 * form removes the question of which copy is current. `tsc` never emits them, which is why the
 * `.ts` file sits next to this module's `.js` in a built image.
 */
function locateEntry(): string {
  const entry = fileURLToPath(new URL('./in-page/collect.ts', import.meta.url));
  if (!existsSync(entry)) {
    throw new BrowserError(
      `in-page collector not found at ${entry} — run \`pnpm --filter indexer build\``,
    );
  }
  return entry;
}
