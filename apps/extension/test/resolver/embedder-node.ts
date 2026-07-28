import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import * as ort from 'onnxruntime-web';

import { fetchEmbeddingModel, MODEL_DIR } from '../../scripts/fetch-embedding-model.js';
import { createOnnxEmbedder, type Embedder } from '../../src/resolver/embedder.js';
import { loadVocab, WordPieceTokenizer } from '../../src/resolver/tokenizer.js';

/**
 * Load the *real* bge-small embedder for the resolver suite, in Node.
 *
 * This is the same `OnnxEmbedder` and the same `WordPieceTokenizer` the extension ships; only the
 * onnxruntime host differs — the extension configures onnxruntime-web for the packaged WASM inside
 * a content script, and here it is pointed at the copy in `node_modules`. The model itself is
 * identical, so the suite asserts against the vectors production will actually produce.
 *
 * `numThreads = 1`: threaded WASM needs `SharedArrayBuffer` and cross-origin isolation, which a
 * content script injected into an arbitrary page does not have — so the extension runs
 * single-threaded, and the test matches it rather than measuring a configuration that will never
 * run for a tester.
 *
 * The model is fetched on demand (idempotent) so `pnpm --filter extension test:resolver` is
 * self-sufficient, the way the indexer's e2e needs `make db-up`.
 */
export async function loadNodeEmbedder(): Promise<Embedder> {
  await fetchEmbeddingModel();

  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = fileURLToPath(
    new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url),
  );

  const model = new Uint8Array(await readFile(`${MODEL_DIR}model_quantized.onnx`));
  const vocab = loadVocab(await readFile(`${MODEL_DIR}vocab.txt`, 'utf8'));
  const tokenizer = new WordPieceTokenizer(vocab);

  return createOnnxEmbedder({
    ort: ort,
    model,
    tokenizer,
  });
}
