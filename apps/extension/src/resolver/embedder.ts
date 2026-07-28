import type { WordPieceTokenizer } from './tokenizer.js';

/**
 * The embedding boundary.
 *
 * T1 is embedding kNN over the scoped candidates' accessible names (docs/BUILD-PLAN.md Phase 8).
 * Everything above this interface — the caching, the ranking, the threshold decision — is pure
 * and unit-tested against a deterministic fake. Everything below it is the real thing: a
 * quantized bge-small ONNX model run through `onnxruntime-web`'s WASM backend, bundled with the
 * extension. Keeping the seam here is what lets the resolver's logic be tested without standing up
 * an inference session, while the session itself is still exercised for real by the fixture suite.
 *
 * Vectors are L2-normalised on the way out, so a caller ranks by dot product and never has to
 * remember to normalise — cosine similarity is just `dot`.
 */
export interface Embedder {
  /** Embedding dimensionality. 384 for bge-small. */
  readonly dims: number;
  /** Embed a batch in one pass. One normalised vector per input, in order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  /** Release the inference session. */
  dispose(): Promise<void>;
}

/* --------------------------------------------------------------------------------------------
 * The minimal slice of onnxruntime we depend on. Typed structurally rather than imported so the
 * resolver's own type-check does not require the native/wasm package to be installed, and so a
 * test can pass `onnxruntime-web` and the extension can pass the same module configured for the
 * packaged wasm — one implementation, two call sites.
 * ------------------------------------------------------------------------------------------ */

export interface OrtTensor {
  readonly data: unknown;
  readonly dims: readonly number[];
}

export type OrtTensorConstructor = new (
  type: 'int64',
  data: BigInt64Array,
  dims: readonly number[],
) => OrtTensor;

export interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}

export interface OrtModule {
  readonly Tensor: OrtTensorConstructor;
  readonly InferenceSession: {
    create(model: Uint8Array | string, options?: unknown): Promise<OrtSession>;
  };
}

export interface OnnxEmbedderOptions {
  readonly ort: OrtModule;
  /** The model bytes, or a path/URL the session loader understands. */
  readonly model: Uint8Array | string;
  readonly tokenizer: WordPieceTokenizer;
  /** Session options passed straight through to `InferenceSession.create`. */
  readonly sessionOptions?: unknown;
}

/**
 * The bge-small embedder.
 *
 * bge pools the `[CLS]` token and normalises — not mean pooling; the model was trained that way,
 * and mean-pooling it would quietly degrade retrieval while still returning plausible vectors.
 * If the exported graph already exposes a pooled `sentence_embedding` output we take it; otherwise
 * we read the `[CLS]` row out of `last_hidden_state` ourselves. Either way the result is
 * L2-normalised here so a mismatch in whether the graph normalised cannot change the ranking.
 */
export async function createOnnxEmbedder(options: OnnxEmbedderOptions): Promise<Embedder> {
  const { ort, tokenizer } = options;
  const session = await ort.InferenceSession.create(options.model, options.sessionOptions);

  const pooledOutput = session.outputNames.find(
    (name) => name === 'sentence_embedding' || name === 'pooler_output',
  );
  const hiddenOutput = session.outputNames.find((name) => name === 'last_hidden_state');
  const maybeOutputName = pooledOutput ?? hiddenOutput ?? session.outputNames[0];
  if (maybeOutputName === undefined) {
    throw new Error('the embedding model exposes no outputs');
  }
  // A fresh binding with a non-optional type: TypeScript does not carry the throw's narrowing
  // into the `embed` closure below, so the widened `string | undefined` would resurface there.
  const outputName: string = maybeOutputName;

  let dims = 0;

  async function embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const encoded = tokenizer.encodeBatch(texts);
    const batch = encoded.inputIds.length;
    const seq = encoded.inputIds[0]?.length ?? 0;

    const feeds: Record<string, OrtTensor> = {};
    // Feed only what the graph declares. bge exports vary in whether they take `token_type_ids`;
    // sending an input the session does not name makes `run` throw.
    for (const name of session.inputNames) {
      const rows =
        name === 'input_ids'
          ? encoded.inputIds
          : name === 'attention_mask'
            ? encoded.attentionMask
            : name === 'token_type_ids'
              ? encoded.tokenTypeIds
              : undefined;
      if (rows === undefined) continue;
      feeds[name] = new ort.Tensor('int64', flattenToInt64(rows), [batch, seq]);
    }

    const results = await session.run(feeds);
    const output = results[outputName];
    if (output === undefined) throw new Error(`model did not produce output ${outputName}`);

    const data = output.data as Float32Array;
    const isPooled = output.dims.length === 2;
    const hidden = output.dims[output.dims.length - 1] ?? 0;
    dims = hidden;

    const vectors: Float32Array[] = [];
    for (let b = 0; b < batch; b += 1) {
      // A pooled `[batch, hidden]` output is read row by row; a `[batch, seq, hidden]` hidden
      // state is CLS-pooled by taking token 0 of each sequence.
      const base = isPooled ? b * hidden : (b * seq + 0) * hidden;
      vectors.push(normalize(data.subarray(base, base + hidden)));
    }
    return vectors;
  }

  return {
    get dims(): number {
      return dims;
    },
    embed,
    async dispose(): Promise<void> {
      await session.release?.();
    },
  };
}

/** Row-major flatten of token ids into the `int64` buffer onnxruntime expects. */
function flattenToInt64(rows: readonly number[][]): BigInt64Array {
  const width = rows[0]?.length ?? 0;
  const flat = new BigInt64Array(rows.length * width);
  let offset = 0;
  for (const row of rows) {
    for (const value of row) {
      flat[offset] = BigInt(value);
      offset += 1;
    }
  }
  return flat;
}

/** L2-normalise a vector into a fresh `Float32Array`. A zero vector is returned unchanged. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  if (norm === 0) return out;
  for (let i = 0; i < vector.length; i += 1) out[i] = (vector[i] ?? 0) / norm;
  return out;
}

/** Dot product of two equal-length vectors — cosine similarity, since both are normalised. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}
