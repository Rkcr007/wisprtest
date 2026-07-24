/**
 * `fingerprint` — element fingerprinting and the scoring resolver.
 *
 * Shared verbatim by the extension and the indexer (CLAUDE.md rule #4). Standard DOM APIs
 * only: no framework, no Node built-ins, no browser-extension globals. If the two consumers
 * ever drift on this logic, resolution breaks.
 *
 * Delivered by Phase 2 of docs/BUILD-PLAN.md — `computeFingerprint`, `scoreCandidate`,
 * `resolve`, `structuralHash`. Empty by design until then.
 */

export {};
