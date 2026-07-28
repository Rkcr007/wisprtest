import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Fetch the bundled T1 embedding model.
 *
 * The quantized bge-small-en-v1.5 ONNX graph and its WordPiece vocabulary are ~33 MB — too large
 * to commit, and not source. This script downloads them into `apps/extension/assets/models/`
 * (gitignored), from where `src/build.ts` copies them into `dist/models/` for the packaged
 * extension, and from where the resolver suite loads them in Node. It is the model's equivalent
 * of `make db-up`: a one-time fetch a test or a build depends on, run by `pnpm --filter extension
 * fetch:model`.
 *
 * The revision is pinned rather than floating on `main`, so the model a build ships and the model
 * a test asserts against cannot change underneath either.
 */

const REPO = 'Xenova/bge-small-en-v1.5';
const REVISION = 'main';

interface Asset {
  readonly remote: string;
  readonly local: string;
  /** A lower bound on the expected size, to catch a truncated or error-page download. */
  readonly minBytes: number;
}

export const MODEL_DIR = fileURLToPath(new URL('../assets/models/bge-small/', import.meta.url));

const ASSETS: readonly Asset[] = [
  { remote: 'onnx/model_quantized.onnx', local: 'model_quantized.onnx', minBytes: 10_000_000 },
  { remote: 'vocab.txt', local: 'vocab.txt', minBytes: 100_000 },
];

function urlFor(asset: Asset): string {
  return `https://huggingface.co/${REPO}/resolve/${REVISION}/${asset.remote}`;
}

async function exists(path: string, minBytes: number): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.size >= minBytes;
  } catch {
    return false;
  }
}

async function download(asset: Asset): Promise<void> {
  const target = `${MODEL_DIR}${asset.local}`;
  if (await exists(target, asset.minBytes)) {
    const sha = createHash('sha256')
      .update(await readFile(target))
      .digest('hex')
      .slice(0, 12);
    process.stdout.write(
      `${JSON.stringify({ event: 'model.cached', file: asset.local, sha256: sha })}\n`,
    );
    return;
  }

  const response = await fetch(urlFor(asset), { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`failed to download ${asset.remote}: HTTP ${String(response.status)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < asset.minBytes) {
    throw new Error(
      `download of ${asset.remote} is only ${String(bytes.byteLength)} bytes — expected at least ${String(asset.minBytes)}`,
    );
  }

  await writeFile(target, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  process.stdout.write(
    `${JSON.stringify({ event: 'model.downloaded', file: asset.local, bytes: bytes.byteLength, sha256: sha })}\n`,
  );
}

export async function fetchEmbeddingModel(): Promise<void> {
  await mkdir(MODEL_DIR, { recursive: true });
  for (const asset of ASSETS) await download(asset);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await fetchEmbeddingModel();
  process.stdout.write(`${JSON.stringify({ event: 'model.ready', dir: MODEL_DIR })}\n`);
}
