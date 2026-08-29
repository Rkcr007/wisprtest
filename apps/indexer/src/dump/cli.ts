import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { HttpUrl } from 'protocol';

import { dumpBounds } from './bounds.js';
import { dumpApplication } from './run.js';

/**
 * `pnpm --filter indexer dump -- --url <http(s)> --out <file>`
 *
 * Indexes a live application onto a MemorySnapshot file. The extension's next track loads
 * that file; the gateway path is unchanged and still the production one.
 */

interface ParsedFlags {
  readonly url: string;
  readonly out: string;
  readonly maxDepth?: number;
  readonly maxPages?: number;
  readonly rpm?: number;
  readonly neverInteract: readonly string[];
  readonly allowPrivate: boolean;
}

class UsageError extends Error {
  readonly code = 'usage' as const;
}

function readFlag(flags: ReadonlyMap<string, readonly string[]>, name: string): string | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  const last = values.at(-1);
  return last;
}

function readInt(flags: ReadonlyMap<string, readonly string[]>, name: string): number | undefined {
  const raw = readFlag(flags, name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be an integer`);
  return value;
}

function parseArgs(argv: readonly string[]): ParsedFlags {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') continue;
    if (!token?.startsWith('--')) {
      throw new UsageError(`unexpected argument: ${token ?? '(end)'}`);
    }
    const name = token.slice(2);
    if (name === 'allow-private') {
      const existing = flags.get(name) ?? [];
      existing.push('true');
      flags.set(name, existing);
      continue;
    }
    const value = argv[i + 1];
    if (value?.startsWith('--') !== false) {
      throw new UsageError(`--${name} needs a value`);
    }
    i += 1;
    const existing = flags.get(name) ?? [];
    existing.push(value);
    flags.set(name, existing);
  }

  const url = readFlag(flags, 'url');
  const out = readFlag(flags, 'out');
  if (url === undefined || out === undefined) {
    throw new UsageError('usage: dump --url <http(s) url> --out <file.json>');
  }

  const parsed = HttpUrl.safeParse(url);
  if (!parsed.success) throw new UsageError('--url must be an absolute http(s) URL');

  const maxDepth = readInt(flags, 'max-depth');
  const maxPages = readInt(flags, 'max-pages');
  const rpm = readInt(flags, 'rpm');
  return {
    url: parsed.data,
    out,
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxPages === undefined ? {} : { maxPages }),
    ...(rpm === undefined ? {} : { rpm }),
    neverInteract: flags.get('never-interact') ?? [],
    allowPrivate: flags.has('allow-private'),
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const flags = parseArgs(argv);
  const origin = new URL(flags.url).origin;
  const bounds = dumpBounds({
    origin,
    ...(flags.maxDepth === undefined ? {} : { maxDepth: flags.maxDepth }),
    ...(flags.maxPages === undefined ? {} : { maxPages: flags.maxPages }),
    ...(flags.rpm === undefined ? {} : { requestsPerMinute: flags.rpm }),
    neverInteractSelectors: flags.neverInteract,
  });

  const result = await dumpApplication({
    baseUrl: flags.url,
    bounds,
    ...(flags.allowPrivate ? { allowPrivateOnAllowlist: true } : {}),
  });
  const dest = resolve(flags.out);
  await writeFile(dest, `${JSON.stringify(result.snapshot, null, 2)}\n`, 'utf8');

  process.stderr.write(
    JSON.stringify({
      event: 'dump.written',
      out: dest,
      screens: result.summary.screensIndexed,
      elements: result.summary.elementsIndexed,
      edges: result.summary.edgesObserved,
      skipped: result.summary.routesSkipped,
      skips: result.skips,
    }) + '\n',
  );
}

const entry = process.argv[1];
const invoked = entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
if (invoked) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'dump failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}

export { main as runDumpCli, parseArgs, UsageError };
