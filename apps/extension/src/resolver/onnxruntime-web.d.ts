/**
 * A minimal ambient declaration for `onnxruntime-web`.
 *
 * The package ships real types, but its `package.json` `exports` map does not expose them under
 * this project's module resolution, so TypeScript resolves the runtime entry to `any`. Rather than
 * let `any` in — CLAUDE.md forbids it — this declares the exact slice the resolver uses:
 * `env.wasm` for the single-threaded WASM configuration, and the `Tensor`/`InferenceSession`
 * surface the `OnnxEmbedder` drives. Everything is consumed through the structural `OrtModule` in
 * `embedder.ts`, so this only has to be accurate about what is actually called.
 */
declare module 'onnxruntime-web' {
  export interface WasmFlags {
    numThreads: number;
    wasmPaths: string;
    simd: boolean;
    proxy: boolean;
  }
  export interface Env {
    readonly wasm: WasmFlags;
  }
  export const env: Env;

  export class Tensor {
    constructor(type: 'int64', data: BigInt64Array, dims: readonly number[]);
    readonly data: unknown;
    readonly dims: readonly number[];
  }

  export interface InferenceSessionInstance {
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
    release(): Promise<void>;
  }

  export const InferenceSession: {
    create(model: Uint8Array | string, options?: unknown): Promise<InferenceSessionInstance>;
  };
}
