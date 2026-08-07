import type { ActionClass, ActionVerb } from 'protocol';

/**
 * The reversibility classifier — the single worst bug in the product, prevented by a table.
 *
 * CLAUDE.md § "Reversibility taxonomy" is the contract:
 *
 * | Class | Meaning     | Speculative execution        | Confirmation                 |
 * |-------|-------------|------------------------------|------------------------------|
 * | R     | Reversible  | Yes, on a partial hypothesis | No                           |
 * | C     | Committing  | **Never**                    | Yes — final transcript + yes |
 * | A     | Ambiguous   | Pre-stage only               | Yes                          |
 * | S     | Seeding     | **Never**                    | Yes — preview before write   |
 *
 * The `ActionRequest` schema in `packages/protocol` already makes it *structurally* impossible to
 * construct a speculative non-`R` request or an unconfirmed `C`/`S` one (its two refinements). This
 * module is the other half: deciding which class an action *is*, before a request is built, so the
 * speculation controller knows whether it may execute a partial hypothesis at all.
 *
 * ## Why `click` is the one committing verb
 *
 * The taxonomy classes an *action* by its effect: submit, delete and approve are `C`; focus, hover,
 * scroll and read-only navigation are `R`. At runtime, on a live application WisprTest did not
 * write, the effect of a click cannot be proven reversible — a button labelled "Save" and a button
 * labelled "Expand" are the same DOM primitive. CLAUDE.md is explicit that "a confident wrong click
 * costs more trust than any latency win gains", so the safe default is to gate every click as `C`.
 *
 * This does not make read-only navigation slow. The {@link IntentParser} routes "open orders",
 * "go to settings" and the like to the `navigate` verb — grounded in the snapshot's nav-edge
 * vocabulary, not a hardcoded app rule — and `navigate` is `R`. Only a genuine button press that
 * names no navigation target falls through to `click`, and gating those is exactly right.
 *
 * Finer per-element reversibility (this particular button only toggles an accordion, so it is
 * really `R`) is real, but it is *learned* knowledge about one application. Per CLAUDE.md
 * § "generic vs per-application" it belongs in the memory record, tagged during indexing — never
 * as an `if (name === 'expand')` here. Until memory carries it, the conservative table stands.
 */

/**
 * Base reversibility class per verb, before the confidence override.
 *
 * `S` (seeding) is produced by no verb here: seeding is its own flow (docs/BUILD-PLAN.md Phase 15),
 * reached through a preview, not through the runtime verb set. It is in the union because the
 * classifier's output type is the full {@link ActionClass}, and a future seeding verb would map to
 * it — but nothing in this phase does.
 */
export type BaseClass = Extract<ActionClass, 'R' | 'C' | 'S'>;

/**
 * The default verb → base-class map. Overridable through {@link ClassifyConfig}, because the
 * per-app reversibility knowledge described above will one day narrow specific clicks to `R`, and
 * that must be a data-driven override rather than an edit to this table.
 */
export const DEFAULT_VERB_CLASSES: Readonly<Record<ActionVerb, BaseClass>> = {
  // Read-only navigation, reversible by going back.
  navigate: 'R',
  back: 'R',
  // Purely reversible interactions with no state mutation.
  focus: 'R',
  scroll: 'R',
  // An assertion: it reads and captures evidence, it never mutates the application.
  check: 'R',
  // Field and view state, reversible by restoring the prior value (see rollback.ts).
  type: 'R',
  filter: 'R',
  select: 'R',
  // The one committing verb. See the module doc for why every click is gated.
  click: 'C',
};

export interface ClassifyConfig {
  /**
   * Confidence a resolution must reach for the action to be classified by its verb rather than as
   * ambiguous. Below it, the action is `A` — staged, never executed — regardless of verb. Mirrors
   * the resolver's `resolutionThreshold` so "resolved" and "safe to classify" agree.
   */
  readonly threshold: number;
  readonly verbClasses: Readonly<Record<ActionVerb, BaseClass>>;
}

export const DEFAULT_CLASSIFY_CONFIG: ClassifyConfig = {
  threshold: 0.72,
  verbClasses: DEFAULT_VERB_CLASSES,
};

export function resolveClassifyConfig(overrides?: Partial<ClassifyConfig>): ClassifyConfig {
  return overrides === undefined
    ? DEFAULT_CLASSIFY_CONFIG
    : { ...DEFAULT_CLASSIFY_CONFIG, ...overrides };
}

/**
 * Conditions outside the resolution itself that bear on how safely it can be acted on.
 *
 * Empty in the ordinary case. Passing a record rather than a bare boolean keeps the call site
 * readable and leaves room for the next such condition without another positional argument.
 */
export interface ClassifyContext {
  /**
   * The screen the tester is on no longer matches the structural hash memory holds for it.
   *
   * Detected in `drift/detect.ts` on route settle. Memory for this screen is known to describe a
   * page that has changed, so a resolution against it is untrustworthy in a way confidence cannot
   * express: a T0 alias hit is *more* confident, not less, when it names an element that has since
   * moved or been removed. The score says the phrase matched what memory holds; it says nothing
   * about whether memory is still true.
   */
  readonly screenDrifted?: boolean;
}

/**
 * Classify an action into its reversibility class.
 *
 * This is `classify(res.action)` from docs/ARCHITECTURE.md § 3, with the confidence gate folded in.
 * The order matches the pseudocode there exactly: a below-threshold confidence makes the action
 * `A` (ambiguous — pre-stage only) *first*, before the verb is even consulted. A low-confidence
 * "approve" is therefore `A`, not `C`: still never executed, and surfaced for disambiguation rather
 * than silent confirmation. When confidence later clears the bar it becomes `C` and needs the
 * explicit yes.
 *
 * ## Drift is checked before confidence
 *
 * A drifted screen forces `A` regardless of verb *or* score, which is the degraded mode
 * `BUILD-PLAN.md` Phase 17 asks for — "continue working in degraded mode. Never block the tester."
 * `A` is precisely that: pre-staged with a reticle, surfaced, never executed without an explicit
 * yes. The tester keeps working; nothing is blocked; the one thing that stops happening is
 * unconfirmed action against memory known to be stale.
 *
 * This is the conservative reading of CLAUDE.md's taxonomy, and it is the one the release gate
 * argues for: false execution rate is < 0.1% and gates every release, while the cost here is an
 * extra confirmation on a screen with a drift report already pending. "A confident wrong click
 * costs more trust than any latency win gains."
 */
export function classifyAction(
  verb: ActionVerb,
  confidence: number,
  config: ClassifyConfig = DEFAULT_CLASSIFY_CONFIG,
  context: ClassifyContext = {},
): ActionClass {
  if (context.screenDrifted === true) return 'A';
  if (confidence < config.threshold) return 'A';
  return config.verbClasses[verb];
}
