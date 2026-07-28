/**
 * Speculation — the reversibility taxonomy at runtime (docs/BUILD-PLAN.md Phase 10).
 *
 * Three pieces cooperate: the {@link IntentParser} turns an utterance into a verb, a target phrase
 * and constraints over the learned vocabulary; the classifier decides the reversibility class; and
 * the {@link SpeculationController} drives the partial → speculate/stage → commit loop from
 * docs/ARCHITECTURE.md § 3, executing class R ahead of a finished sentence and gating class C
 * behind a final transcript, a stability window and an explicit confirmation.
 *
 * The controller depends on the resolver (Phase 8), the executor (this phase) and a live-element
 * {@link Locator} that reuses the shared fingerprint binder — so nothing here re-implements element
 * identity (CLAUDE.md rule #4).
 */

export { createIntentParser, buildIntentVocabulary, EMPTY_VOCABULARY, DEFAULT_VERB_LEXICON } from './intent.js';
export type { IntentParser, ParsedIntent, IntentVocabulary, IntentParserOptions } from './intent.js';
export {
  classifyAction,
  DEFAULT_CLASSIFY_CONFIG,
  DEFAULT_VERB_CLASSES,
  resolveClassifyConfig,
} from './classify.js';
export type { ClassifyConfig, BaseClass } from './classify.js';
export { captureRollback } from './rollback.js';
export type { RollbackRecord, RollbackContext } from './rollback.js';
export { createBinderLocator } from './locate.js';
export type { Locator } from './locate.js';
export { createSpeculationController, IDLE_VIEW } from './controller.js';
export type {
  SpeculationController,
  SpeculationControllerOptions,
  SpeculationView,
  Hypothesis,
  ControllerSource,
  ResolverLike,
} from './controller.js';
