import type { ReactNode } from 'react';
import { Chip, type Tone } from 'ui';

import type { SeedFieldView, SeedNodeView, SeedView } from '../seed/index.js';
import type { MaterializerKind, ProvenanceEntry } from 'protocol';

/**
 * The seed preview card — what a tester approves, and everything they need to approve it.
 *
 * docs/TEST-DATA-ENGINE.md § 6, step 2 lists exactly what has to be on it: "entity, field values,
 * provenance per field, record count, adapter that will run, and whether it can be reverted". All
 * six are here, and none of them is optional, because each one answers a question a tester would
 * otherwise have to find out by looking:
 *
 * - **The values and their provenance.** § 3 calls provenance non-negotiable and says why: an
 *   explanation like "matched from 64 known accounts" is what makes generated data trustworthy
 *   rather than spooky. A value with no reason behind it is a number the tester has to go verify.
 * - **The adapter.** § 4: "Never silently degrade without telling the tester which adapter ran — it
 *   changes what the test actually covered. If the API adapter created the record, client-side
 *   validation was never exercised, and the tester needs to know that." So the adapter is stated
 *   *before* the write, along with the reason it and not another was chosen.
 * - **Whether it can be reverted.** § 5: "When `inverseOp` is `none`, say so in the preview
 *   **before** creating. A tester deciding whether to seed a record that cannot be removed deserves
 *   to know that up front." An unrevertable record is called out as a warning, not a footnote.
 *
 * ## Approval is a real decision, so it is a real button
 *
 * There is no auto-approve, no timeout that approves, and no default focus that could turn a stray
 * Enter into a write. CLAUDE.md § "Reversibility taxonomy" puts seeding in the same "never
 * speculative" column as a committing action, and § 6 is explicit that "the default is, and stays,
 * approval". The two buttons are equally prominent for the same reason: a card where "Approve" is
 * the obvious one and "Discard" is a grey link is a card that gets approved without being read.
 *
 * ## Not a dialog
 *
 * A `region`, like every other band of the HUD. A dialog would trap focus and imply the tester must
 * deal with it before touching the application again — but a tester who asked for a precondition
 * and then changed their mind should be able to simply carry on, and the plan expires unapproved.
 */

/** The adapter names, phrased for a tester rather than for the chain that ordered them. */
const ADAPTER_LABEL: Record<MaterializerKind, string> = {
  api: 'API',
  ui: 'the real form',
  fixture: 'the fixture endpoint',
};

/**
 * How each provenance source is drawn.
 *
 * `requested` is what the tester actually said and reads as committed; `sampled` and `derived` are
 * the system's own choices and read as memory — knowledge it had, not an instruction it was given.
 * `predicate_solved` is called out in the seed colour because it is the least obvious one: a
 * back-dated due date exists to make "overdue" true, and a tester scanning values should see that
 * the date was chosen rather than sampled.
 */
const SOURCE_TONE: Record<ProvenanceEntry['source'], Tone> = {
  requested: 'commit',
  reference_matched: 'commit',
  sampled: 'memory',
  derived: 'memory',
  predicate_solved: 'seed',
  default: 'neutral',
};

const SOURCE_LABEL: Record<ProvenanceEntry['source'], string> = {
  requested: 'you asked for this',
  reference_matched: 'matched an existing record',
  sampled: 'sampled from this app',
  derived: 'derived',
  predicate_solved: 'solved to satisfy a predicate',
  default: 'schema default',
};

export interface SeedPreviewProps {
  readonly view: SeedView;
  /** The tester's explicit yes. The only path to a write. */
  readonly onApprove: () => void;
  /** Dismiss without approving. The held plan lapses server-side, unapproved. */
  readonly onDismiss: () => void;
  /** Undo everything this session seeded, in reverse dependency order. */
  readonly onRevertSession: () => void;
}

/**
 * Render a composed value.
 *
 * Values are the *composer's* output — sampled from this application's observed distributions, or
 * taken from what the tester asked for. They are not the customer's data, and they are not
 * persisted anywhere by this component; they are shown so a person can decide whether to create
 * them.
 */
function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '(unrenderable)';
  }
}

function FieldRow({ field }: { readonly field: SeedFieldView }): ReactNode {
  return (
    <li className="wispr-seed__field" data-testid={`wispr-seed-field-${field.field}`}>
      <span className="wispr-seed__field-head">
        <span className="wispr-seed__field-name">{field.field}</span>
        <span className="wispr-seed__field-value">{renderValue(field.value)}</span>
        <Chip tone={SOURCE_TONE[field.source]} title={SOURCE_LABEL[field.source]}>
          {field.source.replace(/_/g, ' ')}
        </Chip>
      </span>
      {/* Verbatim from the composer. § 3 requires it to be specific — "matched from 64 known
          accounts", not "generated" — and rewording it here would flatten exactly that. */}
      <span className="wispr-seed__field-why">{field.explanation}</span>
    </li>
  );
}

function NodeCard({
  node,
  index,
}: {
  readonly node: SeedNodeView;
  readonly index: number;
}): ReactNode {
  const reused = node.mode === 'reuse_existing';

  return (
    <li className="wispr-seed__node" data-testid={`wispr-seed-node-${node.nodeId}`}>
      <div className="wispr-seed__node-head">
        <span className="wispr-seed__node-ordinal">{index + 1}</span>
        <span className="wispr-seed__node-entity">{node.entity}</span>
        {reused ? (
          <Chip
            tone="memory"
            title="An existing record is reused. Nothing is created for this row."
          >
            reuse existing
          </Chip>
        ) : (
          <Chip tone="seed" title={node.adapterReason}>
            {node.adapter === null ? 'adapter unknown' : `via ${ADAPTER_LABEL[node.adapter]}`}
          </Chip>
        )}
      </div>

      {/* Why this adapter and not another. A preview that silently chose the second-best adapter
          would let a tester draw the wrong conclusion about what the test covered. */}
      {reused ? null : (
        <p className="wispr-seed__adapter-why" data-testid={`wispr-seed-adapter-${node.nodeId}`}>
          {node.adapterReason}
        </p>
      )}

      {/* Reversibility, stated before the write. `none` is a warning because it is one. */}
      <p
        className={`wispr-seed__revert${node.revertible ? '' : ' wispr-seed__revert--none'}`}
        data-testid={`wispr-seed-revert-${node.nodeId}`}
        data-revertible={String(node.revertible)}
      >
        {node.revertible ? '↩ ' : '⚠ '}
        {node.revertDetail}
      </p>

      {node.fields.length === 0 ? null : (
        <ul className="wispr-seed__fields">
          {node.fields.map((field) => (
            <FieldRow key={field.field} field={field} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SeedPreview({
  view,
  onApprove,
  onDismiss,
  onRevertSession,
}: SeedPreviewProps): ReactNode {
  if (view.phase === 'idle') return null;

  const creating = view.nodes.filter((node) => node.mode === 'create').length;
  const unrevertable = view.nodes.filter(
    (node) => node.mode === 'create' && !node.revertible,
  ).length;

  return (
    <div
      className="wispr-hud__band wispr-seed"
      role="region"
      aria-label="Seed preview"
      data-testid="wispr-seed"
      data-phase={view.phase}
    >
      <div className="wispr-seed__head">
        <span className="wispr-hud__intent-label">Test data</span>
        <Chip tone="seed" live={view.phase === 'planning' || view.phase === 'executing'}>
          {PHASE_LABEL[view.phase]}
        </Chip>
        {/* The record count, per § 6. Stated as a count of *writes*, so a reused reference is not
            counted as something being created. */}
        {view.phase === 'previewing' ? (
          <span className="wispr-seed__count" data-testid="wispr-seed-count">
            {creating === 1 ? '1 record' : `${String(creating)} records`}
          </span>
        ) : null}
      </div>

      {view.utterance === null ? null : (
        <p className="wispr-seed__utterance" data-testid="wispr-seed-utterance">
          “{view.utterance}”
        </p>
      )}

      {/* A conflict or a refusal. Both are answers the tester reads and acts on, not failures. */}
      {view.answer === null ? null : (
        <p className="wispr-seed__answer" data-testid="wispr-seed-answer">
          {view.answer}
        </p>
      )}

      {view.error === null ? null : (
        <p className="wispr-seed__error" data-testid="wispr-seed-error" role="status">
          {view.error}
        </p>
      )}

      {view.nodes.length === 0 ? null : (
        <ul className="wispr-seed__nodes">
          {view.nodes.map((node, index) => (
            <NodeCard key={node.nodeId} node={node} index={index} />
          ))}
        </ul>
      )}

      {/* The one thing a tester must not miss, so it is not buried in a per-record line. */}
      {view.phase === 'previewing' && unrevertable > 0 ? (
        <p className="wispr-seed__warning" data-testid="wispr-seed-unrevertable" role="status">
          ⚠{' '}
          {unrevertable === 1
            ? 'One of these records cannot be removed afterwards.'
            : `${String(unrevertable)} of these records cannot be removed afterwards.`}{' '}
          Approving creates it permanently.
        </p>
      ) : null}

      {/* What actually ran, once it has. Every rung of the chain, failures included — § 4 forbids
          silent degradation, and a chain that fell back is a chain the tester has to know about. */}
      {view.result === null ? null : (
        <ul className="wispr-seed__attempts" data-testid="wispr-seed-attempts">
          {view.result.attempts.map((attempt, index) => (
            <li key={`${attempt.adapter}-${String(index)}`} className="wispr-seed__attempt">
              <Chip tone={attempt.outcome === 'succeeded' ? 'commit' : 'drift'}>
                {ADAPTER_LABEL[attempt.adapter]} · {attempt.outcome}
              </Chip>
              {attempt.reason === null ? null : (
                <span className="wispr-seed__attempt-why">{attempt.reason}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {view.ledger.length === 0 ? null : (
        <p className="wispr-seed__created" data-testid="wispr-seed-created">
          Created: {view.ledger.map((entry) => `${entry.entity} ${entry.externalRef}`).join(', ')}
        </p>
      )}

      {/* Outcomes of a revert, entry by entry. Partial success is normal and is reported as such. */}
      {view.reverted.length === 0 ? null : (
        <ul className="wispr-seed__reverted" data-testid="wispr-seed-reverted">
          {view.reverted.map((outcome) => (
            <li key={outcome.ledgerEntryId} className="wispr-seed__attempt">
              <Chip tone={outcome.outcome === 'reverted' ? 'commit' : 'drift'}>
                {outcome.externalRef} · {outcome.outcome.replace(/_/g, ' ')}
              </Chip>
              {outcome.reason === null ? null : (
                <span className="wispr-seed__attempt-why">{outcome.reason}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="wispr-seed__actions">
        {view.phase === 'previewing' ? (
          <>
            {/* Equally weighted, deliberately. The approve button carries no autofocus: a stray
                Enter must never become a write to a customer's application. */}
            <button
              type="button"
              className="wispr-hud__button wispr-hud__button--primary"
              onClick={onApprove}
              data-testid="wispr-seed-approve"
            >
              Approve and create
            </button>
            <button
              type="button"
              className="wispr-hud__button"
              onClick={onDismiss}
              data-testid="wispr-seed-discard"
            >
              Discard
            </button>
          </>
        ) : null}

        {view.phase === 'executed' && view.ledger.length > 0 ? (
          <button
            type="button"
            className="wispr-hud__button"
            onClick={onRevertSession}
            data-testid="wispr-seed-revert"
          >
            Revert {view.ledger.length === 1 ? 'this record' : 'these records'}
          </button>
        ) : null}

        {view.phase === 'answered' || view.phase === 'failed' || view.phase === 'executed' ? (
          <button
            type="button"
            className="wispr-hud__button"
            onClick={onDismiss}
            data-testid="wispr-seed-dismiss"
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}

const PHASE_LABEL: Record<SeedView['phase'], string> = {
  idle: 'idle',
  planning: 'composing…',
  previewing: 'awaiting your approval',
  answered: 'nothing to create',
  executing: 'creating…',
  executed: 'created',
  reverting: 'reverting…',
  failed: 'failed',
};
