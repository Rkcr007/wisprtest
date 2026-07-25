import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build, context, type BuildOptions } from 'esbuild';

import { buildManifest } from './manifest.js';

/**
 * The extension build.
 *
 * `tsc` alone cannot produce a loadable MV3 extension: a content script has no module resolution,
 * so React and `packages/ui` have to be bundled into it. esbuild does that — the same bundler the
 * indexer uses for its in-page collector, so there is one bundling story in the repository.
 *
 * ## What it emits, and where
 *
 * Everything lands in `dist/`, and **`dist/` is the directory you load as an unpacked extension**:
 * Chrome requires `manifest.json` at the root it is given, and the manifest is generated (see
 * `manifest.ts`) so that every permission can carry its justification in code.
 *
 * ```
 * dist/manifest.json   generated from src/manifest.ts
 * dist/background.js   ESM — MV3 service workers support modules
 * dist/content.js      IIFE — content scripts do not
 * ```
 *
 * ## Build-time constants
 *
 * The gateway origin has to be baked in: `host_permissions` is static in a manifest, and the
 * fetch and the permission must name the same origin or the request is blocked at runtime. Both
 * are derived from one `--gateway-origin` here, which is what stops them from drifting apart.
 */

export interface BuildConfig {
  readonly outDir: string;
  readonly gatewayOrigin: string;
  readonly env: 'development' | 'production' | 'test';
  readonly version: string;
  readonly watch: boolean;
}

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * Workspace packages, resolved to their source.
 *
 * Everything the extension ships is bundled into one file, so reading a package's `dist` would
 * buy nothing and cost the whole class of bug where a build silently ships the last version of
 * `ui` that somebody remembered to compile.
 *
 * Exported because `vitest.config.ts` needs the same mapping — one declaration, two consumers.
 * `tsconfig.json` states it a third time in `paths`, which is the one copy that cannot import
 * this file.
 */
export const WORKSPACE_ALIASES: Readonly<Record<string, string>> = {
  protocol: fileURLToPath(new URL('../../../packages/protocol/src/index.ts', import.meta.url)),
  ui: fileURLToPath(new URL('../../../packages/ui/src/index.ts', import.meta.url)),
};

export function buildOptions(config: BuildConfig): {
  background: BuildOptions;
  content: BuildOptions;
} {
  const define = {
    __WISPR_GATEWAY_ORIGIN__: JSON.stringify(config.gatewayOrigin),
    __WISPR_ENV__: JSON.stringify(config.env),
    __WISPR_VERSION__: JSON.stringify(config.version),
    // React reads this. Without it the development build ships React's dev warnings into a
    // customer's page, and the production build keeps its invariant messages.
    'process.env.NODE_ENV': JSON.stringify(
      config.env === 'production' ? 'production' : 'development',
    ),
  };

  const shared: BuildOptions = {
    bundle: true,
    define,
    alias: { ...WORKSPACE_ALIASES },
    target: 'chrome116',
    platform: 'browser',
    // Kept readable in development so a stack trace in a tester's console names our functions;
    // minified for release because this code is injected into every page the tester visits.
    minify: config.env === 'production',
    sourcemap: config.env === 'production' ? false : 'inline',
    logLevel: 'warning',
    jsx: 'automatic',
    legalComments: 'none',
  };

  return {
    background: {
      ...shared,
      entryPoints: [`${here}background/main.ts`],
      outfile: `${config.outDir}/background.js`,
      // MV3 service workers are declared `type: module` in the manifest, so ESM is what they take.
      format: 'esm',
    },
    content: {
      ...shared,
      entryPoints: [`${here}content/main.tsx`],
      outfile: `${config.outDir}/content.js`,
      // A content script is a classic script: `import` at its top level is a syntax error.
      format: 'iife',
    },
  };
}

export async function runBuild(config: BuildConfig): Promise<void> {
  await rm(config.outDir, { recursive: true, force: true });
  await mkdir(config.outDir, { recursive: true });

  await writeFile(
    `${config.outDir}/manifest.json`,
    `${JSON.stringify(
      buildManifest({ version: config.version, gatewayOrigin: config.gatewayOrigin }),
      null,
      2,
    )}\n`,
  );

  const options = buildOptions(config);

  if (!config.watch) {
    await Promise.all([build(options.background), build(options.content)]);
    return;
  }

  const contexts = await Promise.all([context(options.background), context(options.content)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
}

/** `--flag value` and `--flag=value` both, because both get typed. */
export function parseArgs(argv: readonly string[]): Record<string, string | true> {
  const parsed: Record<string, string | true> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg?.startsWith('--') !== true) continue;

    const [name = '', inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) {
      parsed[name] = inline;
      continue;
    }

    const next = argv[index + 1];
    if (next?.startsWith('--') === false) {
      parsed[name] = next;
      index += 1;
      continue;
    }
    parsed[name] = true;
  }

  return parsed;
}

function requireString(value: string | true | undefined, flag: string, fallback?: string): string {
  if (typeof value === 'string' && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${flag} is required`);
}

export function configFromArgs(argv: readonly string[], env: NodeJS.ProcessEnv): BuildConfig {
  const args = parseArgs(argv);
  const envName = requireString(args.env, 'env', 'development');

  if (envName !== 'development' && envName !== 'production' && envName !== 'test') {
    throw new Error(`--env must be development, production or test (got ${envName})`);
  }

  return {
    outDir: requireString(
      args.outdir,
      'outdir',
      fileURLToPath(new URL('../dist', import.meta.url)),
    ),
    // Falls back to the same variable the gateway binds to, so a local `make dev` needs no flag.
    // There is no baked-in default beyond that: a build that silently points at the wrong control
    // plane is a build that fails at runtime, in a customer's tab, with a CORS error.
    gatewayOrigin: requireString(
      args['gateway-origin'],
      'gateway-origin',
      env.GATEWAY_ORIGIN ??
        `http://${env.GATEWAY_HOST ?? '127.0.0.1'}:${env.GATEWAY_PORT ?? '8080'}`,
    ),
    env: envName,
    version: requireString(args.version, 'version', '0.0.0'),
    watch: args.watch === true,
  };
}

// `import.meta.main` is not available on this Node version; comparing argv[1] is the portable form.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = configFromArgs(process.argv.slice(2), process.env);
  await runBuild(config);
  if (!config.watch) {
    process.stdout.write(
      `${JSON.stringify({
        event: 'extension.built',
        out_dir: config.outDir,
        env: config.env,
        gateway_origin: config.gatewayOrigin,
      })}\n`,
    );
  }
}
