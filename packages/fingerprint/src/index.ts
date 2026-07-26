/**
 * `fingerprint` — element fingerprinting and the scoring resolver.
 *
 * Shared verbatim by the extension and the Playwright indexer (CLAUDE.md rule #4). Standard DOM
 * APIs only: no framework, no Node built-ins, no extension globals. If the two consumers ever
 * drift on this logic, resolution breaks — which is why an ESLint rule forbids `node:` imports
 * in this package's source, and why the SHA-256 here is hand-written rather than delegated to a
 * platform API that only one of the two environments has.
 *
 * ## The public API
 *
 * ```ts
 * computeFingerprint(el, ctx)          // → ElementFingerprint
 * scoreCandidate(fingerprint, live)    // → 0..1
 * resolve(query, candidates, options)  // → ResolutionResult
 * structuralHash(root)                 // → Sha256Hex, for drift detection
 * ```
 *
 * Shapes come from `packages/protocol`. This package computes the contract's payloads; it does
 * not define them.
 *
 * ## What else is shared, and why it is here
 *
 * Element identity is not the only thing the indexer and the extension must agree on to the
 * byte. Three more families of DOM semantics live here for exactly the same reason:
 *
 * - `route-pattern.ts` — `/orders/1841` → `/orders/:id`. One half of the screen key.
 * - `runtime-state.ts` — `computeStateFingerprint`, and the modal stack and focused landmark it
 *   hashes. The other half of the screen key: what a screen is stored under and looked up by.
 * - `interactive.ts` — which elements are candidates at all. The indexer records this set; the
 *   runtime scopes resolution to it.
 *
 * A drift in any of these fails silently — memory looks complete and resolution simply returns
 * nothing — which is worse than a drift in scoring, where confidence at least sags visibly.
 *
 * ## The seven signals
 *
 * Implemented with the weights in docs/ARCHITECTURE.md § 2, which live in `DEFAULT_CONFIG` and
 * are overridable per call — they are "config, tuned per corpus, not constants scattered in
 * code". Signals that cannot be evaluated are excluded and their weight redistributed, so a
 * score means "how well the available evidence agrees", not "how much evidence there was".
 *
 * ## PII
 *
 * Every accessible name and every run of element text passes through a `Redactor` before it is
 * hashed, stored or returned. There is no path around it. See CLAUDE.md § "PII rule".
 *
 * ## One documented deviation
 *
 * `resolve` takes candidates as `{ record, element }` pairs rather than bare `Element[]`. The
 * reason is in `resolve.ts`: the return type requires identity that only memory holds, and
 * scoring requires a stored fingerprint to compare against. `packages/protocol` was not changed.
 */

export { computeAccessibleName } from './accname.js';
export {
  extractStableAttributes,
  extractStructuralAttributes,
  isGeneratedValue,
} from './attributes.js';
export {
  DEFAULT_CONFIG,
  DEFAULT_SIGNAL_WEIGHTS,
  resolveConfig,
  resolveContext,
  viewportFor,
} from './config.js';
export type {
  FingerprintConfig,
  FingerprintConfigOverrides,
  PageContext,
  Rect,
  ResolvedContext,
  SignalName,
  SignalWeights,
  Viewport,
} from './config.js';
export { computeFingerprint, computeOrdinal } from './fingerprint.js';
export { bboxSimilarity, normalizeRect } from './geometry.js';
export {
  INTERACTIVE_ROLES,
  interactiveCandidates,
  isDisabled,
  isInert,
  isInteractiveByAuthorIntent,
  isInteractiveCandidate,
  isSemanticallyHidden,
  isStyleHidden,
  isVisible,
} from './interactive.js';
export { computeLandmarkPath, landmarkPathSimilarity } from './landmarks.js';
export { defaultRedactor, normalizeWhitespace } from './redact.js';
export type { Redactor } from './redact.js';
export { resolve } from './resolve.js';
export type { ResolveOptions, ScopedCandidate } from './resolve.js';
export { computeRole } from './role.js';
export {
  DATE_PLACEHOLDER,
  ID_PLACEHOLDER,
  generalizeSegment,
  pathOf,
  screenLabel,
  toRoutePattern,
} from './route-pattern.js';
export {
  computeStateFingerprint,
  landmarkOf,
  readFocusedLandmark,
  readModalStack,
  topmostDialog,
} from './runtime-state.js';
export {
  compareFingerprints,
  scoreCandidate,
  scoreCandidateDetailed,
  textSimilarity,
} from './score.js';
export type { ScoreDetail, SignalBreakdown, SignalScore } from './score.js';
export { sha256Hex } from './sha256.js';
export { structuralHash } from './structural-hash.js';
export { computeTextShingleHash, shingles } from './text.js';
