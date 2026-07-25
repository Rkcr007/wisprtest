import { useState } from 'react';
import type { ReactNode } from 'react';
import { Cell, Chip, Toast, useDraggable, VadBars, type Tone } from 'ui';

import type { AttachState, HudUpdate } from '../messaging.js';

/**
 * The HUD.
 *
 * Three bands, per docs/BUILD-PLAN.md Phase 6:
 *
 * 1. **Live** — grip, attach orb, voice activity, transcript, and the controls.
 * 2. **Intent** — what the system understood: verb, target, constraints.
 * 3. **Telemetry** — tier, latency, and what the session is attached to.
 *
 * ## Why so much of it renders an em dash
 *
 * Voice arrives in Phase 9, resolution in Phase 8, execution in Phase 10. Until then the intent
 * band has no intent to show and the telemetry band has no resolutions to count. Those fields
 * render `—`, announced as "no data yet", rather than `0` or a plausible-looking sample.
 *
 * That is not a placeholder in the sense CLAUDE.md rule #1 forbids — nothing here fakes a
 * result. It is the opposite: a zero in "T0 hits" would be a measurement nobody took, and a
 * tester reading it would conclude the compounding loop is broken rather than absent. The shape
 * of the band is real, its plumbing is real, and its values are honestly empty.
 */

export interface HudProps {
  readonly update: HudUpdate;
  readonly onAttach: () => void;
  readonly onDetach: () => void;
  /** The page the HUD is mounted on. Origin only — never the path, which is content. */
  readonly origin: string;
  readonly version: string;
}

const ATTACH_LABEL: Record<AttachState, string> = {
  detached: 'Detached',
  attaching: 'Attaching…',
  attached: 'Attached',
  failed: 'Attach failed',
};

const ATTACH_TONE: Record<AttachState, Tone> = {
  detached: 'neutral',
  attaching: 'signal',
  attached: 'commit',
  failed: 'drift',
};

/** What a tester should do about a failure, in words that name the next action. */
const FAILURE_DETAIL: Record<'unauthenticated' | 'unreachable' | 'internal', string> = {
  unauthenticated: 'Sign in to the WisprTest console, then attach again.',
  unreachable: 'The control plane did not answer. This is not something you can fix here.',
  internal: 'Something went wrong on our side. Try again, and report it if it persists.',
};

export function Hud({ update, onAttach, onDetach, origin, version }: HudProps): ReactNode {
  const [collapsed, setCollapsed] = useState(true);
  const draggable = useDraggable({ initial: { x: 16, y: 16 } });

  const attached = update.attach === 'attached';
  const busy = update.attach === 'attaching';

  return (
    <div className="wispr-hud-root" data-wispr-hud="root">
      <div
        ref={draggable.ref}
        className={`wispr-hud${collapsed ? ' wispr-hud--collapsed' : ''}${draggable.dragging ? ' wispr-hud--dragging' : ''}`}
        style={draggable.style}
        // A region rather than a dialog: a dialog implies the tester has to deal with it before
        // returning to the page, and this must never be that.
        role="region"
        aria-label="WisprTest panel"
        data-testid="wispr-hud"
        data-attach={update.attach}
        data-collapsed={String(collapsed)}
      >
        {/* ── Band 1: live ────────────────────────────────────────────────────────────── */}
        <div className="wispr-hud__band">
          <span {...draggable.handleProps} className="wispr-hud__grip" data-testid="wispr-hud-grip">
            <span className="wispr-hud__grip-line" />
            <span className="wispr-hud__grip-line" />
            <span className="wispr-hud__grip-line" />
          </span>

          <span
            className={`wispr-hud__orb wispr-hud__orb--${update.attach}`}
            role="img"
            aria-label={ATTACH_LABEL[update.attach]}
            data-testid="wispr-hud-orb"
          />

          {/* Level is null: the microphone is not open in this phase, and a flat-but-live meter
              would say it was. Phase 9 supplies the level. */}
          <VadBars level={null} />

          <span className="wispr-hud__transcript" data-testid="wispr-hud-transcript">
            {attached ? 'Ready — voice arrives in a later phase' : 'Not attached'}
          </span>

          <span className="wispr-hud__actions">
            <button
              type="button"
              className={`wispr-hud__button${attached ? '' : ' wispr-hud__button--primary'}`}
              onClick={attached || busy ? onDetach : onAttach}
              disabled={busy}
              data-testid="wispr-hud-attach"
            >
              {attached || busy ? 'Detach' : 'Attach'}
            </button>
            <button
              type="button"
              className="wispr-hud__button"
              onClick={() => {
                setCollapsed((previous) => !previous);
              }}
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand the WisprTest panel' : 'Collapse the WisprTest panel'}
              data-testid="wispr-hud-collapse"
            >
              {collapsed ? '▸' : '▾'}
            </button>
          </span>
        </div>

        {collapsed ? null : (
          <>
            {/* ── Band 2: intent ──────────────────────────────────────────────────────── */}
            <div className="wispr-hud__band wispr-hud__intent" data-testid="wispr-hud-intent">
              <span className="wispr-hud__intent-row">
                <span className="wispr-hud__intent-label">Intent</span>
                <Chip tone="signal">awaiting speech</Chip>
              </span>
              <span className="wispr-hud__intent-row">
                <span className="wispr-hud__intent-label">Target</span>
                <Cell label="element" value={null} />
                <Cell label="class" value={null} />
              </span>
            </div>

            {/* ── Band 3: telemetry ───────────────────────────────────────────────────── */}
            <div className="wispr-hud__band">
              <div className="wispr-hud__telemetry" data-testid="wispr-hud-telemetry">
                <Cell
                  label="Attach"
                  value={ATTACH_LABEL[update.attach]}
                  tone={ATTACH_TONE[update.attach]}
                />
                <Cell
                  label="Token"
                  value={update.token === 'absent' ? null : update.token}
                  tone={update.token === 'failed' ? 'drift' : 'memory'}
                />
                <Cell
                  label="Application"
                  value={update.applicationId === null ? null : shortId(update.applicationId)}
                  tone="memory"
                />
                {/* These three are what later phases fill in. Empty, and saying so. */}
                <Cell label="Tier" value={null} tone="memory" />
                <Cell label="Resolve" value={null} unit="ms" />
                <Cell label="Steps" value={null} />
              </div>
            </div>

            <p className="wispr-hud__note">
              {update.attach === 'attached' && update.applicationId === null
                ? `No application is registered for ${origin}. Index it from the console to give the HUD something to resolve against.`
                : `${origin} · v${version}`}
            </p>

            {update.attach === 'failed' && update.failure !== null ? (
              <div className="wispr-hud__toast-slot">
                <Toast
                  tone="drift"
                  title={ATTACH_LABEL.failed}
                  detail={FAILURE_DETAIL[update.failure]}
                  onDismiss={onDetach}
                  dismissLabel="Dismiss"
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** First segment of a UUID. Enough to recognise, short enough for a cell. */
function shortId(id: string): string {
  return id.split('-')[0] ?? id;
}
