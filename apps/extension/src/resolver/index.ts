/**
 * The resolver — turning a phrase into an element, in-process, on the hot path.
 *
 * `createResolver` is the single entry point (docs/ARCHITECTURE.md § 3): it reads the current
 * screen and scoped candidate set from the runtime state engine, tries T0 (exact and alias) and
 * then T1 (local embedding kNN over the scoped candidates' accessible names), and returns a
 * `ResolutionResult` with its tier and confidence. Below threshold it returns ranked candidates
 * for disambiguation rather than guessing. T2 is Phase 11.
 *
 * Nothing here crosses the network: the memory snapshot is fetched once on attach by the service
 * worker's `MemoryClient` and handed to the content script, and the embedding model is bundled
 * with the extension and run through onnxruntime-web's WASM backend in-process.
 */
export { createResolver } from './resolver.js';
export type { Resolver, ResolverOptions, ResolverStateSource } from './resolver.js';
export { DEFAULT_RESOLVER_CONFIG, resolveResolverConfig } from './config.js';
export type { ResolverConfig } from './config.js';
export { createCandidateBinder } from './candidate-binder.js';
export type { BoundCandidate, CandidateBinder, ScreenBinding } from './candidate-binder.js';
export { buildAliasIndex, resolveT0 } from './tier0.js';
export type { AliasIndex } from './tier0.js';
export { createTier1Resolver } from './tier1.js';
export type { Tier1Resolver } from './tier1.js';
export { createOnnxEmbedder, dot, normalize } from './embedder.js';
export type { Embedder, OrtModule, OrtSession, OrtTensor } from './embedder.js';
export { createBrowserEmbedder } from './browser-embedder.js';
export type { BrowserEmbedderOptions } from './browser-embedder.js';
export { WordPieceTokenizer, basicTokenize, loadVocab } from './tokenizer.js';
export type { EncodedBatch } from './tokenizer.js';
export { normalizePhrase, phrasesEqual } from './normalize.js';
