import { useState } from 'react';
import type { ReactNode } from 'react';
import { Cell, Chip, Reticle, Toast, useDraggable, VadBars, type Tone } from 'ui';

import { INITIAL_VOICE, type AttachState, type HudUpdate, type HudVoice } from '../messaging.js';
import type { Disambiguation } from '../resolver/index.js';
import { IDLE_SEED_VIEW, type SeedView } from '../seed/index.js';
import type { SpeculationView } from '../speculation/index.js';
import type { ActionClass } from 'protocol';
import type { VoicePhase } from '../voice/messages.js';
import { SeedMarks } from './SeedMarks.js';
import { SeedPreview } from './SeedPreview.js';

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

/** The idle speculation view, so a HUD rendered before anyone speaks shows no reticle. */
const IDLE_SPECULATION: SpeculationView = {
  phase: 'idle',
  rect: null,
  label: null,
  verb: null,
  actionClass: null,
  confidence: null,
  awaitingConfirmation: false,
};

/** The tone each reversibility class is drawn in — truthful about what is about to happen. */
const CLASS_TONE: Record<ActionClass, Tone> = {
  R: 'commit', // reversible; runs freely
  C: 'signal', // committing; aimed, awaiting the tester's yes
  A: 'memory', // ambiguous; needs disambiguation
  S: 'seed', // seeding; previewed before write
};

export interface HudProps {
  readonly update: HudUpdate;
  /** The voice pipeline's tester-facing state. Defaults to idle before anyone has spoken. */
  readonly voice?: HudVoice;
  /** The speculation controller's view: the reticle, the understood intent, and its class. */
  readonly speculation?: SpeculationView;
  /** Called when the tester approves a staged class-C action. */
  readonly onConfirm?: () => void;
  /**
   * The open disambiguation, when no tier could name an element (Phase 11).
   *
   * Numbered because the tester answers by *speaking* an ordinal — "one, two, or three" — while
   * their hands are on the application under test. The buttons are the same choice for a tester
   * who would rather click, and both paths write the correction back as an alias.
   */
  readonly disambiguation?: Disambiguation | null;
  /** Called with the one-based ordinal the tester picked. */
  readonly onChoose?: (ordinal: number) => void;
  /**
   * The seeding flow's view (Phase 15): the preview awaiting approval, or what was created.
   *
   * Rendered as its own band rather than folded into the intent band, because it is not an intent —
   * it is a decision the tester has to make, with enough detail to make it. Defaults to idle, so a
   * HUD built before anything was seeded renders no card.
   */
  readonly seed?: SeedView;
  /** The tester's explicit approval of a previewed plan. The only path to a write. */
  readonly onSeedApprove?: () => void;
  /** Dismiss the card without approving. The held plan lapses server-side. */
  readonly onSeedDismiss?: () => void;
  /** Undo everything this session seeded, in reverse dependency order. */
  readonly onSeedRevert?: () => void;
  /**
   * The screen no longer matches the structural hash memory holds for it (Phase 17).
   *
   * Renders a notice and nothing else — it never takes focus, never gates input, and the tester can
   * keep working straight through it. What it explains is why they are suddenly being asked to
   * confirm actions that normally run on sight: a drifted screen classifies every resolution as
   * class A, because memory is describing a page that has changed.
   */
  readonly drifted?: boolean;
  /** Dismiss the drift notice for this screen. The report is already raised; this hides the band. */
  readonly onDriftDismiss?: () => void;
  /**
   * The runtime state engine's fingerprint, so the marks over created records re-measure when the
   * page moves under them. Null before the engine exists.
   */
  readonly stateFingerprint?: string | null;
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

/** The voice phase, phrased for the state chip. `dropped` is called out as a loss, not a status. */
const VOICE_LABEL: Record<VoicePhase, string> = {
  idle: 'Hold to talk',
  connecting: 'Connecting…',
  listening: 'Listening',
  reconnecting: 'Reconnecting…',
  dropped: 'Audio dropped',
  error: 'Voice unavailable',
};

const VOICE_TONE: Record<VoicePhase, Tone> = {
  idle: 'neutral',
  connecting: 'signal',
  listening: 'signal',
  reconnecting: 'signal',
  dropped: 'drift',
  error: 'drift',
};

/**
 * The word a tester says for each offered position.
 *
 * Only three, because that is `disambiguationLimit` — a spoken list longer than "one, two, or
 * three" is one the tester has to re-read instead of answering.
 */
const ORDINAL_WORD: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three' };

/** The mic is open only while these phases are live; the meter is flat (null) otherwise. */
const LISTENING_PHASES = new Set<VoicePhase>(['listening', 'reconnecting', 'dropped']);

export function Hud({
  update,
  voice = INITIAL_VOICE,
  speculation = IDLE_SPECULATION,
  onConfirm,
  disambiguation = null,
  onChoose,
  seed = IDLE_SEED_VIEW,
  onSeedApprove,
  onSeedDismiss,
  onSeedRevert,
  drifted = false,
  onDriftDismiss,
  stateFingerprint = null,
  onAttach,
  onDetach,
  origin,
  version,
}: HudProps): ReactNode {
  const [collapsed, setCollapsed] = useState(true);
  const draggable = useDraggable({ initial: { x: 16, y: 16 } });

  const attached = update.attach === 'attached';
  const busy = update.attach === 'attaching';
  const listening = LISTENING_PHASES.has(voice.phase);

  // The reticle is hidden when idle; its colour tracks the taxonomy — `staged` for a class-C action
  // waiting on a yes, `executed` only once something has actually run.
  const reticleRect = speculation.phase === 'idle' ? null : speculation.rect;
  const reticleState = speculation.phase === 'idle' ? 'aiming' : speculation.phase;

  return (
    <div className="wispr-hud-root" data-wispr-hud="root">
      <Reticle
        rect={reticleRect}
        state={reticleState}
        {...(speculation.label === null ? {} : { label: speculation.label })}
      />

      {/* The distinct visual treatment § 6 step 5 asks for: an outline over every record in the
          application that exists because this session asked for it. Drawn here, in our own shadow
          root, so the application's DOM is never touched. */}
      <SeedMarks
        externalRefs={seed.ledger.map((entry) => entry.externalRef)}
        stateFingerprint={stateFingerprint}
      />
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

          {/* Live only while the microphone is open; flat otherwise, so "not listening" and
              "listening to a quiet room" never look the same. */}
          <VadBars level={listening ? voice.level : null} />

          <span
            className="wispr-hud__transcript"
            data-testid="wispr-hud-transcript"
            data-voice-phase={voice.phase}
          >
            {renderTranscript(attached, voice)}
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

        {/* ── Seed preview ────────────────────────────────────────────────────────────────
            Outside the collapse, deliberately. Every other band is detail a tester expands when
            they want it; this one is a question being asked of them, and a card that hid itself
            behind a chevron would be a plan expiring unread. It renders nothing when idle. */}
        <SeedPreview
          view={seed}
          onApprove={() => onSeedApprove?.()}
          onDismiss={() => onSeedDismiss?.()}
          onRevertSession={() => onSeedRevert?.()}
        />

        {/* ── Drift notice ───────────────────────────────────────────────────────────────
            Outside the collapse, like the seed card and for a related reason: it explains a
            change in how the panel is about to behave, and a tester who cannot see it would
            experience the degraded mode as the HUD suddenly refusing to act.

            `Toast` with the `drift` tone is an `alert`, so it interrupts a screen reader's
            announcement — right for "the application changed under you". It interrupts the
            announcement and nothing else: no focus is taken, no input is gated, and the tester
            keeps working. Phase 17: "show a NON-BLOCKING notice ... Never block the tester." */}
        {drifted ? (
          <div className="wispr-hud__toast-slot" data-testid="wispr-hud-drift">
            <Toast
              tone="drift"
              title="This screen changed since it was indexed"
              detail="Actions need confirming until a reviewer approves the update. Everything else works as usual."
              {...(onDriftDismiss === undefined ? {} : { onDismiss: onDriftDismiss })}
              dismissLabel="Hide"
            />
          </div>
        ) : null}

        {collapsed ? null : (
          <>
            {/* ── Band 2: intent ──────────────────────────────────────────────────────── */}
            <div className="wispr-hud__band wispr-hud__intent" data-testid="wispr-hud-intent">
              <span className="wispr-hud__intent-row">
                <span className="wispr-hud__intent-label">Voice</span>
                <Chip tone={VOICE_TONE[voice.phase]} live>
                  {VOICE_LABEL[voice.phase]}
                </Chip>
              </span>
              <span className="wispr-hud__intent-row">
                <span className="wispr-hud__intent-label">Target</span>
                <Cell label="element" value={speculation.label} />
                <Cell
                  label="class"
                  value={speculation.actionClass}
                  {...(speculation.actionClass === null
                    ? {}
                    : { tone: CLASS_TONE[speculation.actionClass] })}
                />
                {speculation.awaitingConfirmation && onConfirm ? (
                  <button
                    type="button"
                    className="wispr-hud__button wispr-hud__button--primary"
                    onClick={onConfirm}
                    data-testid="wispr-hud-confirm"
                  >
                    Confirm
                  </button>
                ) : null}
              </span>
            </div>

            {/* ── Disambiguation: only while a choice is open ─────────────────────────── */}
            {disambiguation === null ? null : (
              <div
                className="wispr-hud__band wispr-hud__disambiguation"
                data-testid="wispr-hud-disambiguation"
              >
                {/* A group, not a dialog: the tester can ignore it and say something else, and a
                    dialog would imply they have to deal with it before touching the page again. */}
                <span className="wispr-hud__intent-label" id="wispr-hud-disambiguation-label">
                  Which one?
                </span>
                <div role="group" aria-labelledby="wispr-hud-disambiguation-label">
                  {disambiguation.choices.map((choice) => (
                    <button
                      key={choice.candidate.elementId}
                      type="button"
                      className="wispr-hud__button"
                      onClick={() => onChoose?.(choice.ordinal)}
                      data-testid={`wispr-hud-choice-${String(choice.ordinal)}`}
                    >
                      {/* The spoken word, not just the digit: the tester says "two", and the label
                          should be the thing they say rather than a number they have to translate. */}
                      <span className="wispr-hud__ordinal">
                        {ORDINAL_WORD[choice.ordinal] ?? String(choice.ordinal)}
                      </span>{' '}
                      {choice.candidate.label || choice.candidate.elementKey}
                    </button>
                  ))}
                </div>
              </div>
            )}

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

/**
 * The live transcript: the confirmed line, then the unconfirmed tail, visually distinguished.
 *
 * The finalized transcript reads as settled; the partial — the in-flight hypothesis, still subject
 * to revision — is rendered in the signal colour as the tail. Showing both is the point: a tester
 * watches their words land and can see which the system has committed to before an action fires.
 */
function renderTranscript(attached: boolean, voice: HudVoice): ReactNode {
  if (!attached) return 'Not attached';

  const final = voice.final?.text ?? '';
  const partial = voice.partial?.text ?? '';

  if (final === '' && partial === '') {
    return voice.phase === 'listening' ? 'Listening…' : 'Hold to talk';
  }

  return (
    <>
      {final !== '' ? <span className="wispr-hud__transcript-final">{final}</span> : null}
      {partial !== '' ? (
        <span className="wispr-hud__transcript-tail" data-testid="wispr-hud-transcript-tail">
          {partial}
        </span>
      ) : null}
    </>
  );
}

/** First segment of a UUID. Enough to recognise, short enough for a cell. */
function shortId(id: string): string {
  return id.split('-')[0] ?? id;
}
