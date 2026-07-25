import type { FingerprintConfig } from './config.js';

/**
 * Stable attribute extraction.
 *
 * Worth 0.20 and, per the ARCHITECTURE table, "near-decisive when present" — a `data-testid` a
 * QA engineer wrote by hand is the strongest identity claim a page can make.
 *
 * The whole value of the signal depends on rejecting the ones a framework minted at render
 * time. A generated id looks exactly as authoritative as a hand-written one and changes every
 * reload, so treating them alike does not merely add noise: it produces confident wrong matches,
 * which is the failure mode CLAUDE.md gates releases on.
 *
 * ## The heuristics, and what each is for
 *
 * A value is rejected when it matches any pattern in `config.generatedValuePatterns`:
 *
 * | Pattern                              | Catches                                          |
 * |--------------------------------------|--------------------------------------------------|
 * | `:r1:`, `:R2ab:`                     | React 18 `useId`, and Radix / Headless UI on top |
 * | `ember123`                           | Ember auto-ids                                    |
 * | `ng-tns-c12-3`, `cdk-overlay-0`, `mat-input-5` | Angular, Angular Material, the CDK      |
 * | `css-1x2y3z`, `sc-bdVaJa`, `jss42`   | Emotion, styled-components, JSS                   |
 * | `Button_root__1a2b3`                 | CSS-module hashed suffixes                        |
 * | `data-v-7ba5bd90`                    | Vue scoped-style markers                          |
 * | `a3f9c1e8…` (8+ hex)                 | Content hashes and nanoids                        |
 * | 16+ chars of `[a-z0-9_-]`            | Longer generated blobs that dodge the hex test    |
 * | any UUID                             | Server-minted row keys used as DOM ids            |
 * | `list-item-1841`, `row_20260725`     | Long trailing counters and date stamps            |
 *
 * ## The trade-off, stated plainly
 *
 * The trailing-counter rule is the aggressive one. `orders-1841` is rejected, and if an
 * application genuinely hand-writes ids with four-digit suffixes it loses this signal on those
 * elements. That is the right direction to be wrong in: losing a signal costs a fraction of
 * confidence and pushes towards disambiguation, whereas trusting a regenerated id costs a
 * wrong click. Two- and three-digit suffixes are kept, because `step-2` and `tab-3` are
 * overwhelmingly hand-written.
 *
 * The list is config, not constants, so an application that needs a different balance can
 * supply one through `PageContext`.
 */

/** True when a value looks framework-generated and must not be trusted as identity. */
export function isGeneratedValue(value: string, config: FingerprintConfig): boolean {
  if (value === '') return true;
  return config.generatedValuePatterns.some((pattern) => pattern.test(value));
}

/**
 * The identity-bearing attributes present on an element, in the config's order of trust.
 *
 * Absent attributes and generated values are both simply left out, so an empty result means
 * "this element makes no stable claim about itself" — which the scorer treats as the signal
 * being inapplicable rather than as a mismatch.
 */
export function extractStableAttributes(
  element: Element,
  config: FingerprintConfig,
): Record<string, string> {
  const attributes: Record<string, string> = {};

  for (const name of config.stableAttributeNames) {
    const value = element.getAttribute(name);
    if (value === null) continue;

    const trimmed = value.trim();
    if (isGeneratedValue(trimmed, config)) continue;

    attributes[name] = trimmed;
  }

  return attributes;
}

/**
 * The attributes hashed into the structural signature.
 *
 * A different list from the stable one: `type` is here because an input changing from `text` to
 * `date` is a component change, and `id` is absent because a hand-written id is identity rather
 * than structure and would make the hash needlessly sensitive.
 */
export function extractStructuralAttributes(element: Element, config: FingerprintConfig): string[] {
  const parts: string[] = [];

  for (const name of config.structuralAttributeNames) {
    const value = element.getAttribute(name);
    if (value === null) continue;

    const trimmed = value.trim();
    // A generated value is recorded as present-but-anonymous. Dropping it entirely would make
    // the hash flip when a framework starts or stops emitting the attribute; keeping the value
    // would make it flip on every render.
    parts.push(`${name}=${isGeneratedValue(trimmed, config) ? '*' : trimmed}`);
  }

  return parts;
}
