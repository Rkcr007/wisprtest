import { defaultRedactor, type Redactor } from './redact.js';

/**
 * Every tunable in the package, in one place.
 *
 * docs/ARCHITECTURE.md § 2 is explicit that the weights are "config, tuned per corpus, not
 * constants scattered in code" — so nothing here is inlined at a call site, and every function
 * takes an optional override. Phase 19's benchmark gates will tune these against a real corpus;
 * the values below are the documented starting point, not a claim to be optimal.
 */

/** The seven fingerprint signals from docs/ARCHITECTURE.md § 2. */
export type SignalName =
  | 'role'
  | 'accessibleName'
  | 'landmarkPath'
  | 'stableAttributes'
  | 'ordinal'
  | 'textShingle'
  | 'bbox';

export interface SignalWeights {
  /** Computed ARIA role. Stable across restyles. */
  readonly role: number;
  /** Accessible name, normalised and PII-scrubbed. The highest single signal. */
  readonly accessibleName: number;
  /** Landmark / section ancestry path. Survives sibling churn. */
  readonly landmarkPath: number;
  /** `data-testid`, `name`, non-generated `id`. Near-decisive when present. */
  readonly stableAttributes: number;
  /** Position within the parent group. Breaks ties in lists. */
  readonly ordinal: number;
  /** Hash of shingled element text. Content-derived, weakest. */
  readonly textShingle: number;
  /** Viewport-normalised bounding box. Last resort. */
  readonly bbox: number;
}

/**
 * The weights from the ARCHITECTURE table, verbatim. They sum to 1.00.
 *
 * | Signal                                    | Weight |
 * |-------------------------------------------|--------|
 * | Computed ARIA role                        | 0.20   |
 * | Accessible name (normalised, PII-scrubbed)| 0.25   |
 * | Landmark / section ancestry path          | 0.15   |
 * | Stable attributes                         | 0.20   |
 * | Ordinal within parent group               | 0.08   |
 * | Text shingle hash                         | 0.07   |
 * | Viewport-normalised bbox                  | 0.05   |
 */
export const DEFAULT_SIGNAL_WEIGHTS: SignalWeights = {
  role: 0.2,
  accessibleName: 0.25,
  landmarkPath: 0.15,
  stableAttributes: 0.2,
  ordinal: 0.08,
  textShingle: 0.07,
  bbox: 0.05,
};

export interface FingerprintConfig {
  readonly weights: SignalWeights;

  /**
   * Attribute names treated as identity-bearing, in descending order of trust.
   *
   * An attribute only counts once its value has passed the generated-value heuristics in
   * `attributes.ts` — a `data-testid` a framework minted at render time is worse than useless,
   * because it looks authoritative and changes every reload.
   */
  readonly stableAttributeNames: readonly string[];

  /**
   * Attributes included in the structural hash, by name.
   *
   * These describe what a node *is*, not what it currently shows: an input's `type`, a form
   * control's `name`, a component's `data-testid`. Their values are hashed. Anything
   * content-bearing — `aria-label`, `title`, `value`, `placeholder` — is deliberately absent,
   * because the structural hash exists to detect component change, not data change.
   */
  readonly structuralAttributeNames: readonly string[];

  /** Patterns that mark an attribute value as framework-generated. See `attributes.ts`. */
  readonly generatedValuePatterns: readonly RegExp[];

  /** Roles treated as landmarks when walking the ancestry path. */
  readonly landmarkRoles: readonly string[];

  /** Words per shingle when hashing element text. */
  readonly shingleSize: number;

  /** Longest text considered when shingling, in characters. Caps cost on a large subtree. */
  readonly maxShingleTextLength: number;

  /** Deepest subtree the structural hash descends into. Caps cost on a pathological page. */
  readonly maxStructuralDepth: number;

  /**
   * Confidence a candidate must reach before `resolve` will name it.
   *
   * Below this the resolver returns ranked candidates for disambiguation. It never picks —
   * "below threshold it escalates rather than guesses", per docs/ARCHITECTURE.md § 2.
   */
  readonly resolutionThreshold: number;

  /**
   * How far the best candidate must lead the runner-up before it counts as resolved.
   *
   * Two controls scoring 0.91 and 0.90 are not a resolution, they are an ambiguity that
   * happens to clear the bar. A confident wrong click costs more trust than any latency win
   * gains, so a near-tie escalates.
   */
  readonly resolutionMargin: number;

  /**
   * Confidence a candidate needs to be worth offering in the disambiguation list.
   *
   * Candidates below this are dropped rather than shown: an ordinal list padded with things
   * the tester obviously did not mean makes the list harder to use, not easier.
   */
  readonly candidateFloor: number;

  /**
   * How much a failed fingerprint match can discount a candidate in `resolve`.
   *
   * Resolution asks two questions: does this element match what the tester said, and is it
   * still the element memory recorded? The first decides; the second discounts. A candidate
   * whose stored fingerprint no longer matches the live node keeps this fraction of its
   * phrase affinity — so drift lowers confidence and pushes towards disambiguation, rather
   * than silently excluding an element the tester can plainly see.
   */
  readonly integrityFloor: number;
}

export const DEFAULT_CONFIG: FingerprintConfig = {
  weights: DEFAULT_SIGNAL_WEIGHTS,

  stableAttributeNames: ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'name', 'id'],

  structuralAttributeNames: ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'name', 'type'],

  generatedValuePatterns: [
    // React 18 `useId`, and the Radix / Headless UI ids derived from it: `:r1:`, `:R2ab:`.
    /^:[a-z0-9]*:?$/i,
    /:[Rr][0-9a-z]*:/,
    // Ember auto-ids: `ember123`.
    /^ember\d+$/i,
    // Angular and Angular Material / CDK: `ng-tns-c12-3`, `cdk-overlay-0`, `mat-input-5`.
    /^(?:ng-tns-|cdk-|mat-|ng-star|_ngcontent|_nghost)/i,
    // Emotion and styled-components: `css-1x2y3z`, `sc-bdVaJa`.
    /^(?:css|sc)-?[0-9a-z]{4,}$/i,
    // JSS, whose counters are short enough to miss the rule above: `jss42`.
    /^jss\d+$/i,
    /^mui-\d+$/i,
    // CSS-module hashed suffixes: `Button_root__1a2b3`, `styles_wrapper__x1Y2z`.
    /__[0-9a-z]{5,}$/i,
    // Vue scoped-style markers and SSR hydration ids.
    /^data-v-[0-9a-f]{6,}$/i,
    // A bare hexadecimal or base-36 blob: almost always a hash or a nanoid.
    /^[0-9a-f]{8,}$/i,
    /^[0-9a-z_-]{16,}$/i,
    // A UUID anywhere in the value.
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    // A long trailing counter: `list-item-1841`, `row_20260725`.
    /[_-]\d{4,}$/,
  ],

  landmarkRoles: [
    'banner',
    'complementary',
    'contentinfo',
    'form',
    'main',
    'navigation',
    'region',
    'search',
    'dialog',
    'alertdialog',
  ],

  shingleSize: 3,
  maxShingleTextLength: 512,
  maxStructuralDepth: 24,

  resolutionThreshold: 0.72,
  resolutionMargin: 0.08,
  candidateFloor: 0.25,
  integrityFloor: 0.6,
};

/**
 * Overlay a partial override onto the defaults.
 *
 * Shallow apart from `weights`, which is merged one level deeper so a caller can retune a
 * single signal without restating the other six.
 */
export function resolveConfig(overrides?: FingerprintConfigOverrides): FingerprintConfig {
  if (overrides === undefined) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    weights: { ...DEFAULT_SIGNAL_WEIGHTS, ...overrides.weights },
  };
}

export type FingerprintConfigOverrides = Partial<Omit<FingerprintConfig, 'weights'>> & {
  readonly weights?: Partial<SignalWeights>;
};

/** Bounds of the area an element's geometry is normalised against. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** An element's position, in the same units `getBoundingClientRect` reports. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Everything `computeFingerprint` needs beyond the element itself.
 *
 * All fields are optional and derived from the element's own document when omitted, so the
 * common call is `computeFingerprint(el, {})`. They exist because the two consumers differ:
 * the extension reads geometry straight from the live layout, while the Playwright indexer
 * measures in bulk and injects the results rather than paying a reflow per element.
 */
export interface PageContext {
  /**
   * The viewport to normalise geometry against.
   *
   * Defaults to the element's own `defaultView`. Supplying it explicitly is what makes a
   * fingerprint reproducible: an element measured at 1920×1080 and re-measured at 1280×720
   * has the same normalised box only if both used the same reference.
   */
  readonly viewport?: Viewport;

  /**
   * How to measure an element. Defaults to `getBoundingClientRect`.
   *
   * The indexer overrides this with measurements taken in one pass, which turns N reflows into
   * one. A stub is also how the test suite gets deterministic geometry out of happy-dom, which
   * does no layout.
   */
  readonly measure?: (element: Element) => Rect;

  /**
   * The PII scrubber applied to every accessible name and every text shingle.
   *
   * Defaults to {@link defaultRedactor}. A tenant whose data needs stricter handling supplies
   * their own; there is no way to opt out of redaction entirely, by design.
   */
  readonly redact?: Redactor;

  /** Weight and heuristic overrides. Defaults to {@link DEFAULT_CONFIG}. */
  readonly config?: FingerprintConfigOverrides;
}

/** The context with every default filled in, as the internals consume it. */
export interface ResolvedContext {
  /** Undefined when the caller pinned none; {@link viewportFor} then derives it per element. */
  readonly viewport: Viewport | undefined;
  readonly measure: (element: Element) => Rect;
  readonly redact: Redactor;
  readonly config: FingerprintConfig;
}

const ZERO_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

function defaultMeasure(element: Element): Rect {
  // `getBoundingClientRect` is on `Element` in every environment this runs in, but happy-dom
  // and a detached node can both return something without it, so this stays defensive rather
  // than throwing inside a signal that is only worth 0.05.
  const rect: unknown = element.getBoundingClientRect();
  if (rect === null || typeof rect !== 'object') return ZERO_RECT;
  const { x, y, width, height } = rect as Partial<Rect>;
  return {
    x: typeof x === 'number' ? x : 0,
    y: typeof y === 'number' ? y : 0,
    width: typeof width === 'number' ? width : 0,
    height: typeof height === 'number' ? height : 0,
  };
}

/** Fallback viewport when an element is detached and no explicit one was given. */
const FALLBACK_VIEWPORT: Viewport = { width: 1280, height: 720 };

export function resolveContext(context: PageContext = {}): ResolvedContext {
  return {
    viewport: context.viewport,
    measure: context.measure ?? defaultMeasure,
    redact: context.redact ?? defaultRedactor,
    config: resolveConfig(context.config),
  };
}

/**
 * The viewport to normalise a given element against.
 *
 * Resolution order: what the caller pinned, then the element's own window, then a fixed
 * fallback. Applied per element rather than once per context, so a context reused across two
 * documents still measures each against the right window.
 */
export function viewportFor(element: Element, context: ResolvedContext): Viewport {
  if (context.viewport !== undefined) return context.viewport;

  const view = element.ownerDocument.defaultView;
  const innerWidth = view?.innerWidth ?? 0;
  const innerHeight = view?.innerHeight ?? 0;
  if (innerWidth > 0 && innerHeight > 0) return { width: innerWidth, height: innerHeight };

  return FALLBACK_VIEWPORT;
}
