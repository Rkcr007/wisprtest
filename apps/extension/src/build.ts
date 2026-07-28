import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
 * dist/manifest.json     generated from src/manifest.ts
 * dist/background.js     ESM — MV3 service workers support modules
 * dist/content.js        IIFE — content scripts do not
 * dist/route-bridge.js   IIFE — runs in the page's own world, see src/runtime/route-bridge.ts
 * dist/offscreen.js      ESM — the voice pipeline's document, owns getUserMedia (Phase 9)
 * dist/offscreen.html    the offscreen document's shell, copied verbatim
 * dist/audio-worklet.js  IIFE — runs on the audio thread, see src/voice/audio-worklet.ts
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
  /**
   * A short-lived ASR credential for local development only, empty by default so nothing is baked
   * into a shipped bundle. In production the worker mints one from the gateway (a later phase);
   * without either, voice surfaces a truthful `no_token` state rather than opening a dead mic.
   */
  readonly asrToken: string;
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
  fingerprint: fileURLToPath(
    new URL('../../../packages/fingerprint/src/index.ts', import.meta.url),
  ),
  protocol: fileURLToPath(new URL('../../../packages/protocol/src/index.ts', import.meta.url)),
  ui: fileURLToPath(new URL('../../../packages/ui/src/index.ts', import.meta.url)),
};

export function buildOptions(config: BuildConfig): {
  background: BuildOptions;
  content: BuildOptions;
  routeBridge: BuildOptions;
  offscreen: BuildOptions;
  audioWorklet: BuildOptions;
} {
  const define = {
    __WISPR_GATEWAY_ORIGIN__: JSON.stringify(config.gatewayOrigin),
    __WISPR_ENV__: JSON.stringify(config.env),
    __WISPR_VERSION__: JSON.stringify(config.version),
    __WISPR_ASR_TOKEN__: JSON.stringify(config.asrToken),
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
    routeBridge: {
      ...shared,
      entryPoints: [`${here}runtime/route-bridge.main.ts`],
      outfile: `${config.outDir}/route-bridge.js`,
      format: 'iife',
      // This one runs in the application's own JavaScript world, sharing globals with the page.
      // Nothing about the extension may leak into it: no React, no design tokens, no
      // `__WISPR_GATEWAY_ORIGIN__`. It is a few dozen lines with no imports, and keeping it
      // minified even in development is part of keeping it that way.
      minify: true,
      sourcemap: false,
    },
    offscreen: {
      ...shared,
      entryPoints: [`${here}voice/offscreen.ts`],
      outfile: `${config.outDir}/offscreen.js`,
      // An offscreen document is a real extension page, so its script is a module like the worker.
      format: 'esm',
    },
    audioWorklet: {
      ...shared,
      entryPoints: [`${here}voice/audio-worklet.ts`],
      outfile: `${config.outDir}/audio-worklet.js`,
      // Loaded by `audioWorklet.addModule` into the audio rendering thread, which has no module
      // system. It has no imports and touches no extension API — it only forwards samples.
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

  // The offscreen document's shell is static HTML esbuild does not process; copy it verbatim so
  // `chrome.offscreen.createDocument({ url: 'offscreen.html' })` has something to load.
  await copyFile(
    fileURLToPath(new URL('./voice/offscreen.html', import.meta.url)),
    `${config.outDir}/offscreen.html`,
  );

  await copyModelAssets(config.outDir);

  const options = Object.values(buildOptions(config));

  if (!config.watch) {
    await Promise.all(options.map((option) => build(option)));
    return;
  }

  const contexts = await Promise.all(options.map((option) => context(option)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
}

/**
 * Copy the T1 embedding model and the onnxruntime WASM runtime into `dist/models/`.
 *
 * The model is fetched, not committed (`pnpm --filter extension fetch:model`), so a build without
 * it is a real state — a developer who has not run the fetch. That warns and continues rather than
 * failing: the extension still builds and loads, and T1 degrades to "model unavailable" at runtime
 * rather than the whole build breaking. A release build is expected to have run the fetch first.
 *
 * The WASM files come straight from the installed `onnxruntime-web`, so the runtime the extension
 * ships is exactly the one it was built against — there is no second copy to drift.
 */
async function copyModelAssets(outDir: string): Promise<void> {
  const modelDir = fileURLToPath(new URL('../assets/models/bge-small/', import.meta.url));
  const ortDir = fileURLToPath(new URL('../node_modules/onnxruntime-web/dist/', import.meta.url));

  if (!(await exists(`${modelDir}model_quantized.onnx`))) {
    process.stderr.write(
      `${JSON.stringify({
        event: 'extension.model_missing',
        detail: 'run `pnpm --filter extension fetch:model`; T1 will be unavailable until then',
      })}\n`,
    );
    return;
  }

  await mkdir(`${outDir}/models/bge-small`, { recursive: true });
  await copyFile(
    `${modelDir}model_quantized.onnx`,
    `${outDir}/models/bge-small/model_quantized.onnx`,
  );
  await copyFile(`${modelDir}vocab.txt`, `${outDir}/models/bge-small/vocab.txt`);

  await mkdir(`${outDir}/models/ort`, { recursive: true });
  // Every `ort-wasm*.{wasm,mjs}` the runtime might select, copied verbatim so onnxruntime-web
  // finds its glue and binary under `wasmPaths` whichever variant it picks at load time.
  for (const file of await readdir(ortDir)) {
    if (/^ort-wasm.*\.(wasm|mjs)$/.test(file)) {
      await copyFile(`${ortDir}${file}`, `${outDir}/models/ort/${file}`);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
    // Empty unless a developer passes one for local voice testing. Never committed, never defaulted
    // to a real value — a bundle with a baked-in provider key would violate CLAUDE.md rule #10.
    asrToken: requireString(args['asr-token'], 'asr-token', env.ASR_TOKEN ?? ''),
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
