/**
 * Design tokens.
 *
 * These are not decorative. Each colour means one thing in this product, and a tester learns the
 * meaning within a session or two: amber is the system aiming, mint is something that actually
 * happened, violet is data WisprTest made up, blue is what it remembered, and orange-red is the
 * application having changed underneath us. Using the seed colour for a hover state, or the
 * commit colour for something that has not committed, does more damage than a bad layout —
 * the tester's trust in "green means it ran" is the whole interface.
 *
 * Consumed by the extension HUD and by the console (docs/BUILD-PLAN.md Phase 18) from this one
 * place, so the two surfaces cannot drift visually.
 *
 * ## Why a TypeScript module and not a `.css` file
 *
 * The HUD lives in a shadow root and adopts a constructed stylesheet — there is no document to
 * link a file into. Emitting the CSS from data also means the *meaning* of each token survives
 * into the artifact as a comment, rather than living only in a design document nobody opens.
 */

/** The semantic role a token plays. `palette` entries are the five product colours. */
export type TokenKind = 'palette' | 'surface' | 'text' | 'space' | 'radius' | 'motion' | 'z';

export interface DesignToken {
  /** Custom property name, without the leading `--`. */
  readonly name: string;
  readonly value: string;
  readonly kind: TokenKind;
  /** What this token *means*. Emitted into the stylesheet as a comment. */
  readonly meaning: string;
}

/**
 * The five product colours, from docs/BUILD-PLAN.md Phase 6.
 *
 * They map to the states a tester needs to tell apart at a glance, from across a desk, while
 * talking. That is why they are far apart in hue rather than a tasteful gradient.
 */
export const PALETTE_TOKENS: readonly DesignToken[] = [
  {
    name: 'signal',
    value: '#FFB454',
    kind: 'palette',
    meaning:
      'Listening, or aiming at a target. The system has heard something and believes it knows ' +
      'what is meant, but has not acted. Every reticle and every VAD bar is this colour.',
  },
  {
    name: 'commit',
    value: '#52E0AC',
    kind: 'palette',
    meaning:
      'Executed. An action was actually dispatched against the application. Never used for ' +
      'anything speculative, staged or merely confident — if it is this colour, it happened.',
  },
  {
    name: 'seed',
    value: '#C88BFF',
    kind: 'palette',
    meaning:
      'Generated test data. Marks records WisprTest composed rather than found, wherever they ' +
      'appear: the seed preview, the ledger, and the created rows in the application itself.',
  },
  {
    name: 'memory',
    value: '#7FA8FF',
    kind: 'palette',
    meaning:
      'Stored knowledge. Anything the system knows because it indexed it: screens, elements, ' +
      'aliases, the navigation graph. Distinguishes what is remembered from what is happening now.',
  },
  {
    name: 'drift',
    value: '#FF6B4A',
    kind: 'palette',
    meaning:
      'Drift. The application no longer matches memory. Warning, never error: drift is expected ' +
      'and non-blocking, and colouring it as a failure would train testers to ignore it.',
  },
];

/**
 * Everything else: surfaces, text, spacing, radii, motion and stacking.
 *
 * Deliberately few. A design system with forty greys is one where nobody can tell you which grey
 * is correct.
 */
export const STRUCTURAL_TOKENS: readonly DesignToken[] = [
  {
    name: 'surface',
    value: 'rgba(18, 20, 26, 0.92)',
    kind: 'surface',
    meaning:
      'The HUD panel itself. Translucent so the tester can see the application behind it, dark ' +
      'so it reads as an overlay rather than part of the page.',
  },
  {
    name: 'surface-raised',
    value: 'rgba(30, 33, 42, 0.96)',
    kind: 'surface',
    meaning: 'A band or card lifted above the panel: the intent band, a toast.',
  },
  {
    name: 'surface-sunken',
    value: 'rgba(10, 11, 15, 0.72)',
    kind: 'surface',
    meaning: 'Inset areas — the transcript well, the VAD strip.',
  },
  {
    name: 'border',
    value: 'rgba(255, 255, 255, 0.12)',
    kind: 'surface',
    meaning: 'Hairline separating bands. Low contrast on purpose: structure, not decoration.',
  },
  {
    name: 'text',
    value: '#F2F4F8',
    kind: 'text',
    meaning: 'Primary text. Meets WCAG AA against the panel surface.',
  },
  {
    name: 'text-muted',
    value: '#A6AEBF',
    kind: 'text',
    meaning:
      'Secondary text: labels, units, and the em dash that means "no data yet". Still AA ' +
      'against the panel surface — muted is not an excuse for unreadable.',
  },
  {
    name: 'focus-ring',
    value: '#FFFFFF',
    kind: 'text',
    meaning:
      'Focus indicator. White rather than a palette colour so it never collides with the ' +
      'meaning of the thing being focused.',
  },
  { name: 'space-1', value: '4px', kind: 'space', meaning: 'Tightest gap: inside a chip.' },
  { name: 'space-2', value: '8px', kind: 'space', meaning: 'Between related controls in a band.' },
  { name: 'space-3', value: '12px', kind: 'space', meaning: 'Band padding.' },
  { name: 'space-4', value: '16px', kind: 'space', meaning: 'Between bands.' },
  { name: 'radius-sm', value: '6px', kind: 'radius', meaning: 'Chips, cells, small controls.' },
  { name: 'radius-md', value: '10px', kind: 'radius', meaning: 'Bands and toasts.' },
  { name: 'radius-lg', value: '14px', kind: 'radius', meaning: 'The HUD panel.' },
  {
    name: 'duration-fast',
    value: '120ms',
    kind: 'motion',
    meaning:
      'Hover, focus and chip changes. Under the ~150ms at which a change stops feeling ' +
      'instantaneous. Collapses to 0ms under prefers-reduced-motion.',
  },
  {
    name: 'duration-medium',
    value: '220ms',
    kind: 'motion',
    meaning:
      'Reticle travel and panel collapse — long enough to be followed by eye, short enough to ' +
      'stay inside the 400ms speech-to-reticle budget. Collapses to 0ms under reduced motion.',
  },
  {
    name: 'easing-spring',
    value: 'cubic-bezier(0.22, 1.2, 0.36, 1)',
    kind: 'motion',
    meaning:
      'The reticle overshoots slightly and settles. That overshoot is what makes an arrival ' +
      'read as an arrival rather than a repaint.',
  },
  {
    name: 'easing-standard',
    value: 'cubic-bezier(0.4, 0, 0.2, 1)',
    kind: 'motion',
    meaning: 'Everything that is not the reticle.',
  },
  {
    name: 'z-hud',
    value: '2147483000',
    kind: 'z',
    meaning:
      'Just under the 32-bit maximum, so the HUD sits above a customer application that has ' +
      'already reached for z-index: 999999 — while leaving room above it for a browser overlay.',
  },
];

export const TOKENS: readonly DesignToken[] = [...PALETTE_TOKENS, ...STRUCTURAL_TOKENS];

/** The custom property name for a token, ready to interpolate: `var(--wispr-signal)`. */
export function tokenVar(name: string): string {
  return `var(--${PREFIX}${name})`;
}

/**
 * A token's literal value.
 *
 * For the few places that cannot use a custom property: the extension's shadow host is styled
 * from TypeScript, and it sits *outside* the stylesheet that defines the properties. Reading the
 * value here keeps that one inline style in step with the rest of the system instead of hard-coding
 * a number a thousand lines away from the token it is supposed to match.
 *
 * @throws when the token does not exist, because the alternative is a silently empty style.
 */
export function tokenValue(name: string): string {
  const token = TOKENS.find((candidate) => candidate.name === name);
  if (token === undefined) throw new Error(`unknown design token: ${name}`);
  return token.value;
}

const PREFIX = 'wispr-';

function declarations(tokens: readonly DesignToken[]): string {
  return tokens
    .map((token) => `  /* ${token.meaning} */\n  --${PREFIX}${token.name}: ${token.value};`)
    .join('\n');
}

/**
 * The token stylesheet.
 *
 * Declared on both `:host` and `:root` so one text works in a shadow root (the extension HUD)
 * and in a normal document (the console), without either consumer restating it.
 *
 * The reduced-motion block zeroes the durations rather than removing transitions at each call
 * site. A component that animates by interpolating a token therefore stops animating without
 * knowing that reduced motion exists — which is the only way this stays true as components are
 * added.
 */
export const tokensCss = `:host, :root {
${declarations(TOKENS)}
}

@media (prefers-reduced-motion: reduce) {
  :host, :root {
    /* Motion is removed at the source. Nothing downstream has to remember to check. */
    --${PREFIX}duration-fast: 0ms;
    --${PREFIX}duration-medium: 0ms;
  }
}
`;
