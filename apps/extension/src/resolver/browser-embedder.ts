import * as ort from 'onnxruntime-web';

import { createOnnxEmbedder, type Embedder } from './embedder.js';
import { loadVocab, WordPieceTokenizer } from './tokenizer.js';

/**
 * The T1 embedder as it runs in the extension: onnxruntime-web's WASM backend, the bundled
 * bge-small model, in the content script where the hot path lives (CLAUDE.md rule #2).
 *
 * The model and the WASM runtime are packaged with the extension and loaded through
 * `chrome.runtime.getURL`; `src/build.ts` copies them into `dist/models/`, and the manifest makes
 * them web-accessible with `use_dynamic_url` so exposing them does not become a stable
 * fingerprint. This is the same `OnnxEmbedder` and `WordPieceTokenizer` the resolver suite runs in
 * Node — only the host and the resource loading differ.
 *
 * `numThreads = 1`: threaded WASM needs `SharedArrayBuffer`, which needs cross-origin isolation
 * the application under test will not have. Single-threaded is the only configuration that runs in
 * an arbitrary page, so it is the one the extension uses and the one the benchmarks measure.
 */

export interface BrowserEmbedderOptions {
  /** `chrome.runtime.getURL`. Injected so this is testable without the extension runtime. */
  readonly getURL: (path: string) => string;
  readonly fetch?: typeof globalThis.fetch;
}

/** Paths inside the packaged extension, relative to `dist/`. */
const MODEL_PATH = 'models/bge-small/model_quantized.onnx';
const VOCAB_PATH = 'models/bge-small/vocab.txt';
const WASM_DIR = 'models/ort/';

export async function createBrowserEmbedder(options: BrowserEmbedderOptions): Promise<Embedder> {
  const { getURL } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  ort.env.wasm.numThreads = 1;
  // The WASM glue and binary sit beside the model; `getURL` yields the dynamic, per-session URL
  // the manifest grants, so onnxruntime resolves them without a stable resource path.
  ort.env.wasm.wasmPaths = getURL(WASM_DIR);

  const [modelResponse, vocabResponse] = await Promise.all([
    fetchImpl(getURL(MODEL_PATH)),
    fetchImpl(getURL(VOCAB_PATH)),
  ]);
  if (!modelResponse.ok || !vocabResponse.ok) {
    throw new Error('failed to load the bundled embedding model from the extension package');
  }

  const model = new Uint8Array(await modelResponse.arrayBuffer());
  const tokenizer = new WordPieceTokenizer(loadVocab(await vocabResponse.text()));

  return createOnnxEmbedder({ ort: ort, model, tokenizer });
}
