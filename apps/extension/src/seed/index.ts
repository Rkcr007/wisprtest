/**
 * `src/seed` — action class **S**, end to end in the extension.
 *
 * The fork that recognises a request for data (`intent.ts`), the state machine that composes,
 * previews and materializes it (`controller.ts`), and the locator that shows the tester which
 * records on screen exist because they asked (`marker.ts`).
 *
 * Everything that can cause a write lives behind `SeedController.approve`, which takes no arguments
 * and can only send back a plan the controller composed itself. See that module for why.
 */

export {
  createSeedIntentDetector,
  DEFAULT_AMBIGUOUS_TRIGGERS,
  DEFAULT_SEED_LEXICON,
  DEFAULT_UNAMBIGUOUS_TRIGGERS,
  type SeedIntent,
  type SeedIntentDetector,
  type SeedIntentDetectorOptions,
  type SeedIntentLexicon,
} from './intent.js';

export {
  buildNodeViews,
  createSeedController,
  IDLE_SEED_VIEW,
  type SeedController,
  type SeedControllerOptions,
  type SeedExecuteOutcome,
  type SeedFailureReason,
  type SeedFieldView,
  type SeedNodeView,
  type SeedPhase,
  type SeedPlanOutcome,
  type SeedRevertResult,
  type SeedTransport,
  type SeedView,
} from './controller.js';

export { findSeedMarks, type FindSeedMarksOptions, type SeedMark } from './marker.js';
