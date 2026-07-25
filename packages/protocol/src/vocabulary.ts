import { z } from 'zod';

import { contract } from './registry.js';

/**
 * Shared enumerations.
 *
 * These sit in their own module because the resolution and runtime domains both need them and
 * a cycle between those two modules would be evaluated in an undefined order at import time.
 */

/**
 * Which resolution tier produced a result. The performance contract, from CLAUDE.md
 * § "Resolution tiers":
 *
 * | Tier | Mechanism                                       | Budget   | Target share |
 * |------|-------------------------------------------------|----------|--------------|
 * | T0   | Exact/alias hit in the in-memory index           | < 15 ms  | > 80%        |
 * | T1   | Local embedding kNN over the scoped candidate set| < 40 ms  | ~15%         |
 * | T2   | Small fast LLM, scoped candidates in prompt      | < 800 ms | < 5%         |
 *
 * Every T2 result writes back an alias so the same phrasing is T0 next time. Tier
 * distribution over time is the product's health metric: if the T0 share is not climbing,
 * the compounding loop is broken.
 */
export const Tier = contract(
  'Tier',
  z.enum(['T0', 'T1', 'T2']).describe('Resolution tier that produced a result.'),
);
export type Tier = z.infer<typeof Tier>;

/**
 * Reversibility class. Restated verbatim from CLAUDE.md § "Reversibility taxonomy" — this
 * table is the contract, and every consumer of an {@link ActionRequest} is bound by it:
 *
 * | Class | Meaning                                                        | Speculative execution      | Confirmation                        |
 * |-------|----------------------------------------------------------------|----------------------------|-------------------------------------|
 * | **R** | Reversible — focus, hover, scroll, expand, read-only navigation | Yes, on partial ASR hypothesis | No                              |
 * | **C** | Committing — submit, delete, approve, any state mutation        | **Never**                  | Yes — finalized transcript + explicit yes |
 * | **A** | Ambiguous — resolver confidence below threshold                 | Pre-stage only (focus + reticle) | Yes                           |
 * | **S** | Seeding — test data creation                                    | **Never**                  | Yes — preview shown before write    |
 *
 * Speculating on a Class C action is the single worst bug this product can have. A confident
 * wrong click costs more trust than any latency win gains.
 *
 * The first two rows of the "Speculative execution" column are enforced structurally by the
 * refinements on {@link ActionRequest}: a request may not be both speculative and non-`R`,
 * and a class `C` request may not be dispatched unconfirmed.
 */
export const ActionClass = contract(
  'ActionClass',
  z
    .enum(['R', 'C', 'A', 'S'])
    .describe(
      'Reversibility class: R reversible, C committing, A ambiguous, S seeding. ' +
        'Only R may execute speculatively; C and S always require explicit confirmation.',
    ),
);
export type ActionClass = z.infer<typeof ActionClass>;

/**
 * The verbs the intent parser produces and the executor dispatches.
 *
 * Deliberately closed and small. A verb that is not on this list is not something the runtime
 * can do, and the parser must report that rather than approximate it.
 */
export const ActionVerb = contract(
  'ActionVerb',
  z
    .enum(['navigate', 'click', 'type', 'focus', 'scroll', 'filter', 'check', 'select', 'back'])
    .describe('Action the runtime can dispatch against the app under test.'),
);
export type ActionVerb = z.infer<typeof ActionVerb>;
