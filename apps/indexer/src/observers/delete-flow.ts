import { entityNameFromPath } from './naming.js';

/**
 * Finding the control that removes a record.
 *
 * docs/TEST-DATA-ENGINE.md § 5 requires every seeded record to carry an inverse operation, and
 * `{ kind: 'none' }` to be shown in the preview *before* the record is created. Both halves need
 * this: a delete flow that exists must be found at index time so the preview can promise a
 * revert, and one that does not must be known to be absent for the same reason. Discovering it at
 * revert time would be too late to have told anybody.
 *
 * ## The hypothesis space is small, explicit, and English
 *
 * The same discipline `derived-rules.ts` holds to. A control is a delete flow when its accessible
 * name *is* one of a short list of removal verbs, optionally followed by what it removes — "Delete",
 * "Remove", "Delete order". Not "contains the word delete", which would match "Delete all
 * completed orders" and "Undelete"; not a learned classifier, which would be unexplainable at
 * exactly the moment somebody is asking why a record vanished.
 *
 * This is English morphology, not application vocabulary, and nothing here may ever learn a
 * customer's terms — CLAUDE.md § "What is generic vs what is per-application". An application that
 * calls it "Bin it" gets `{ kind: 'none' }` and a tester who is told so up front, which is the
 * honest outcome. The console's materializer configuration is where a QA lead will eventually be
 * able to say otherwise.
 *
 * ## Why the *first* one is as good as any
 *
 * A list renders one delete control per row, and they are indistinguishable. Any of them is a
 * correct answer to "what does deleting look like here", because the record a delete is aimed at
 * is decided at revert time from the record's own path, not from which button was indexed —
 * see `locateRecordControl` in `crawl/in-page/seed.ts`.
 */

/**
 * Removal verbs, and only removal verbs.
 *
 * `archive` and `cancel` are deliberately absent. Both are destructive-adjacent and neither
 * removes a record: archiving hides it and cancelling changes its status, so treating either as
 * an inverse operation would tell a tester their seeded row was gone when it is still there,
 * still in the list, still affecting the next assertion.
 */
const REMOVAL_VERBS = ['delete', 'remove', 'destroy', 'discard'];

/**
 * `Delete`, `Remove order`, `Delete this invoice` — a verb, then at most what it acts on.
 *
 * The trailing group is capped at three words. Past that the control is describing a bulk action
 * or a workflow ("Delete all archived orders before June"), and a bulk control is emphatically
 * not the inverse of creating one record.
 */
const REMOVAL_NAME = new RegExp(
  `^(?:${REMOVAL_VERBS.join('|')})(?:\\s+[\\p{L}\\p{N}'’-]+){0,3}\\s*$`,
  'iu',
);

/** One indexed control, as the delete-flow search sees it. */
export interface DeleteFlowCandidate {
  readonly elementKey: string;
  readonly routePattern: string;
  /** Redacted accessible name, as stored on the fingerprint. Never a raw one. */
  readonly accessibleNameRedacted: string;
  readonly role: string;
}

/** Whether an accessible name names a control that removes one record. */
export function isRemovalName(name: string): boolean {
  return REMOVAL_NAME.test(name.trim());
}

/**
 * The delete flow for each entity, keyed by entity name.
 *
 * An entity is attributed by the route the control sits on, using the same `entityNameFromPath`
 * the schema observers name entities with — so a control on `/orders` belongs to `Order` and one
 * on `/orders/:id` does too. Sharing that function is what stops the two halves of the data engine
 * disagreeing about what an entity is called.
 *
 * Only roles that are actually activatable qualify. A `<td>` reading "Deleted" is not a delete
 * flow, and a crawl that indexed one as an element would otherwise contribute it.
 */
export function findDeleteFlows(candidates: readonly DeleteFlowCandidate[]): Map<string, string> {
  const flows = new Map<string, string>();

  for (const candidate of candidates) {
    if (candidate.role !== 'button' && candidate.role !== 'link') continue;
    if (!isRemovalName(candidate.accessibleNameRedacted)) continue;

    const entity = entityNameFromPath(candidate.routePattern);
    if (entity === null) continue;
    if (flows.has(entity)) continue;

    flows.set(entity, candidate.elementKey);
  }

  return flows;
}
