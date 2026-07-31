import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { EscalateResponse, EvidenceRef, MemorySnapshot, type ResolutionResult } from 'protocol';

import {
  HUD_PORT,
  INITIAL_UPDATE,
  INITIAL_VOICE,
  parseWorkerMessage,
  type HudUpdate,
  type HudVoice,
} from '../messaging.js';
import {
  CDP_MESSAGE,
  createActionExecutor,
  createRelayDispatcher,
  type CdpCommand,
} from '../executor/index.js';
import {
  createBrowserEmbedder,
  createResolver,
  type Disambiguation,
  type EscalationOutcome,
  type Resolver,
} from '../resolver/index.js';
import { createRuntimeStateEngine, type RuntimeStateEngine } from '../runtime/index.js';
import {
  captureRegion,
  containingLandmark,
  serializeRedacted,
  shouldCapture,
} from '../session/index.js';
import {
  buildIntentVocabulary,
  createBinderLocator,
  createIntentParser,
  createSpeculationController,
  IDLE_VIEW,
  type SpeculationController,
  type SpeculationView,
} from '../speculation/index.js';
import { createHotkey } from '../voice/hotkey.js';
import { DEFAULT_VOICE_SETTINGS } from '../voice/config.js';
import { Hud } from './Hud.js';
import { mountHudHost } from './mount.js';

/** A resolution the controller reads as "nothing matched" while the T1 model is still loading. */
const NOT_FOUND: ResolutionResult = {
  outcome: 'not_found',
  tier: 'T1',
  latencyMs: 0,
  candidates: [],
};

/**
 * Relay one CDP command to the service worker and await its acknowledgement.
 *
 * `chrome.debugger` is unreachable from a content script, so the executor's trusted dispatch goes
 * worker-side; this awaits the reply so a command the worker could not run rejects here and the
 * executor records a failed action rather than a silent miss.
 */
async function sendCdp(command: CdpCommand): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage({ type: CDP_MESSAGE, command });
  if (
    typeof response !== 'object' ||
    response === null ||
    (response as { ok?: unknown }).ok !== true
  ) {
    const error = (response as { error?: unknown } | null)?.error;
    throw new Error(typeof error === 'string' ? error : 'cdp dispatch failed');
  }
}

/**
 * How long the content script waits for the worker's answer to an escalation.
 *
 * The gateway's 800 ms budget and the worker's own guard sit under this; it fires only when the
 * service worker was terminated mid-escalation and no reply is ever coming. Without it the
 * resolver would await a promise nobody will settle, and the utterance would hang instead of
 * falling back to disambiguation.
 */
const ESCALATE_REPLY_TIMEOUT_MS = 3_000;

/** The word a clicked ordinal is spoken as, so the click path enters the same parser speech does. */
const ORDINAL_WORD: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three' };

/**
 * How long a capture waits for the worker.
 *
 * Longer than an escalation's, because this one crosses the network twice — a ticket, then the
 * upload — and it delays only a timeline row rather than a command. It exists so a terminated
 * worker cannot leave the executor awaiting a promise nobody will settle.
 */
const CAPTURE_REPLY_TIMEOUT_MS = 8_000;

/** Destination route for a navigation trigger, learned from the snapshot's nav graph. */
function buildNavRoutes(snapshot: MemorySnapshot): (elementId: string) => string | null {
  const routeByScreen = new Map(snapshot.screens.map((screen) => [screen.id, screen.routePattern]));
  const routeByTrigger = new Map<string, string>();
  for (const edge of snapshot.navEdges) {
    const route = routeByScreen.get(edge.toScreenId);
    if (route !== undefined) routeByTrigger.set(edge.triggerElementId, route);
  }
  return (elementId) => routeByTrigger.get(elementId) ?? null;
}

/**
 * Content script entrypoint.
 *
 * Injected into every page the tester visits, and deliberately close to inert until they attach:
 * it mounts a collapsed panel in a shadow root, opens a port to the service worker, and does
 * nothing else. It reads no page content, sends no page content anywhere, and holds no
 * credentials — the token stays in the worker (see `background/token-store.ts`).
 *
 * ## Why the content script opens the port
 *
 * A port opened from here needs no host permission, while pushing to a content script with
 * `chrome.tabs.sendMessage` does. It also gives the worker a disconnect signal for free: when the
 * tab navigates or closes, the port drops and the worker discards the session.
 *
 * ## Focus is never taken
 *
 * Nothing here calls `focus()`. The tester is typing into the application under test, and an
 * overlay that steals focus on mount would eat the keystroke that was in flight.
 *
 * ## The runtime state engine starts on attach, not on injection
 *
 * `src/runtime` observes the page: a `MutationObserver` over the whole document, an
 * `IntersectionObserver` per interactive element, and a structural hash of the body. That is a
 * reasonable cost while a tester is testing, and an unreasonable one on every page they happen to
 * visit — this script is injected into all of them. So the engine is created when the attach
 * state machine reaches `attached` and disposed the moment it leaves.
 */

declare const __WISPR_VERSION__: string;

function HudApp({
  version,
  hudHost,
}: {
  readonly version: string;
  readonly hudHost: Element;
}): ReactNode {
  const [update, setUpdate] = useState<HudUpdate>(INITIAL_UPDATE);
  const [voice, setVoice] = useState<HudVoice>(INITIAL_VOICE);
  const [port, setPort] = useState<chrome.runtime.Port | null>(null);
  /**
   * The same port, as a ref.
   *
   * The resolver is built once per (engine, snapshot) and holds its escalation transport for that
   * lifetime; reading the port through a ref keeps a reconnect from rebuilding the resolver — and
   * with it the embedding cache — for a change the transport can simply read next time it fires.
   */
  const portRef = useRef<chrome.runtime.Port | null>(null);

  /**
   * The engine, while attached, and the memory snapshot the worker pushed.
   *
   * Both are state rather than refs so the resolver effect below can rebuild when either appears:
   * the resolver needs the engine's live state and the snapshot's memory together, and they arrive
   * independently — the engine when the tester attaches, the snapshot when the worker finishes
   * fetching it.
   */
  const [engine, setEngine] = useState<RuntimeStateEngine | null>(null);
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  /** The resolver, once memory and the engine are both present. Driven by the controller below. */
  const resolver = useRef<Resolver | null>(null);
  /** The speculation controller and the view it publishes for the reticle and intent bands. */
  const controllerRef = useRef<SpeculationController | null>(null);
  const [speculation, setSpeculation] = useState<SpeculationView>(IDLE_VIEW);
  /** The open numbered choice, when no tier could name an element. Rendered by the HUD. */
  const [disambiguation, setDisambiguation] = useState<Disambiguation | null>(null);
  /**
   * Escalations awaiting the worker's reply, by request id.
   *
   * A port is a stream, not a call: two escalations can be in flight when speech revises
   * mid-utterance, so each carries an id and settles its own promise.
   */
  const escalations = useRef(new Map<string, (outcome: EscalationOutcome) => void>());
  /** Evidence captures awaiting the worker's reply, by request id. */
  const captures = useRef(new Map<string, (refs: readonly EvidenceRef[]) => void>());
  // Transition tracking, so the voice snapshot below drives one onset/partial/final per change.
  const prevPhaseRef = useRef<HudVoice['phase']>('idle');
  const lastPartialRef = useRef(-1);
  const lastFinalRef = useRef(-1);
  const attached = update.attach === 'attached';

  /**
   * Send one escalation to the worker and await its reply.
   *
   * The content script cannot call the gateway itself: the scoped token lives in the worker and
   * never crosses into the page (`messaging.ts`). Every failure — no port, a dead worker, a
   * refused pick — resolves rather than rejects, because the resolver reads the outcome and falls
   * back to the ranked T1 candidates. Nothing here can throw onto the hot path.
   */
  const escalate = useCallback(
    (request: unknown): Promise<EscalationOutcome> =>
      new Promise<EscalationOutcome>((settle) => {
        const target = portRef.current;
        if (target === null) {
          settle({ ok: false, reason: 'unavailable' });
          return;
        }

        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          escalations.current.delete(requestId);
          settle({ ok: false, reason: 'timeout' });
        }, ESCALATE_REPLY_TIMEOUT_MS);

        escalations.current.set(requestId, (outcome) => {
          clearTimeout(timer);
          settle(outcome);
        });

        try {
          target.postMessage({ kind: 'escalate', requestId, request });
        } catch {
          // The worker was terminated between the ref read and the post.
          clearTimeout(timer);
          escalations.current.delete(requestId);
          settle({ ok: false, reason: 'unavailable' });
        }
      }),
    [],
  );

  /**
   * Capture evidence for a step that is about to be recorded.
   *
   * The split follows the trust boundary. This side serialises the containing landmark and
   * **redacts it here**, because this is the only side that can read the DOM and therefore the
   * only side that must guarantee no raw page text ever leaves it. The worker takes the screenshot
   * over its debugger attachment and uploads both with the scoped token.
   *
   * Resolves to an empty list on any failure — no port, a dead worker, a refused ticket. Evidence
   * explains a step; it is not the step.
   */
  const captureEvidence = useCallback(
    (input: {
      element: Element;
      verb: string;
      outcome: string;
      ordinal: number;
    }): Promise<readonly EvidenceRef[]> => {
      // Checks and failures only. A screenshot per click would upload a great deal of a customer's
      // screen for a question nobody asks.
      if (!shouldCapture({ verb: input.verb, outcome: input.outcome })) {
        return Promise.resolve([]);
      }

      const target = portRef.current;
      if (target === null) return Promise.resolve([]);

      return new Promise<readonly EvidenceRef[]>((settle) => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          captures.current.delete(requestId);
          settle([]);
        }, CAPTURE_REPLY_TIMEOUT_MS);

        captures.current.set(requestId, (refs) => {
          clearTimeout(timer);
          settle(refs);
        });

        try {
          target.postMessage({
            kind: 'capture_evidence',
            requestId,
            stepOrdinal: input.ordinal,
            // Redacted before it crosses. The worker never sees raw page text.
            snapshotHtml: serializeRedacted(containingLandmark(input.element)),
            region: captureRegion(input.element, {
              width: window.innerWidth,
              height: window.innerHeight,
            }),
          });
        } catch {
          clearTimeout(timer);
          captures.current.delete(requestId);
          settle([]);
        }
      });
    },
    [],
  );

  /**
   * Hand a recorded step to the worker's session buffer.
   *
   * Fire and forget: the action it describes has already run. A step lost to a terminated worker
   * costs one row of history, never a command — which is why nothing here awaits or throws.
   */
  const sendStep = useCallback((step: unknown) => {
    try {
      portRef.current?.postMessage({ kind: 'session_step', step });
    } catch {
      // The worker was terminated between the ref read and the post.
    }
  }, []);

  /** Hand a learned alias to the worker's write-back queue. Fire and forget, by design. */
  const sendAlias = useCallback((writeback: unknown) => {
    try {
      portRef.current?.postMessage({ kind: 'alias_writeback', writeback });
    } catch {
      // A write-back lost to a terminated worker costs one future T0 hit, not a resolution.
    }
  }, []);

  useEffect(() => {
    if (!attached) return undefined;

    const started = createRuntimeStateEngine({
      window,
      // Our own shadow host is not the application. Without this the state fingerprint would
      // move every time the tester dragged the panel — invalidating the scoped resolution cache
      // and, through the same key, reading as drift.
      ignoreFocus: (element) => element === hudHost,
    });
    setEngine(started);

    return () => {
      setEngine(null);
      started.dispose();
    };
  }, [attached, hudHost]);

  /**
   * Build the resolver once the engine and the snapshot are both present.
   *
   * The embedding model loads asynchronously from the packaged extension, so construction is
   * async and guarded against the effect being torn down mid-load. The resolver is held in a ref
   * for Phase 10's speculation controller to drive; nothing calls it here. A failure to load the
   * model leaves T1 unavailable and is logged, not thrown — T0 still resolves without it.
   */
  useEffect(() => {
    if (engine === null || snapshot === null) return undefined;

    // A holder rather than a bare `let`: the effect's cleanup flips `cancelled` after this async
    // build has already been scheduled, and reading a mutable field is what keeps the check honest
    // instead of a value flow-analysis would fold to a constant.
    const lifecycle: {
      cancelled: boolean;
      built: Resolver | null;
      controller: SpeculationController | null;
      viewSub: { unsubscribe(): void } | null;
    } = { cancelled: false, built: null, controller: null, viewSub: null };

    // The live scope, shared by the resolver and the controller: the current screen's fingerprint
    // and its visible, reachable elements.
    const source = {
      current: () => ({
        stateFingerprint: engine.state.value.stateFingerprint,
        candidates: engine.scopedIndex.candidates(),
      }),
    };

    void (async () => {
      try {
        const embedder = await createBrowserEmbedder({
          getURL: (path) => chrome.runtime.getURL(path),
        });
        if (lifecycle.cancelled) {
          await embedder.dispose();
          return;
        }
        lifecycle.built = createResolver({
          snapshot,
          embedder,
          source,
          // T2 and the write-back that makes it worth doing. Both go through the worker, which
          // holds the token; this side never sees a credential.
          escalate,
          onAlias: sendAlias,
        });
        resolver.current = lifecycle.built;

        // The runtime loop: parse → resolve → speculate/stage → commit → execute, all in-process.
        // The executor's trusted dispatch is relayed to the worker, which owns `chrome.debugger`.
        const controller = createSpeculationController({
          parser: createIntentParser({ vocabulary: buildIntentVocabulary(snapshot) }),
          // Passed through with one addition: every call republishes whatever choice the resolver
          // is now asking for — a list when no tier could name an element, null the moment one did
          // or the tester answered — so the HUD's numbered band follows the resolver exactly.
          resolver: {
            resolve: async (phrase) => {
              const result = await (resolver.current?.resolve(phrase) ??
                Promise.resolve(NOT_FOUND));
              setDisambiguation(resolver.current?.pending() ?? null);
              return result;
            },
            pending: () => resolver.current?.pending() ?? null,
            choose: (ordinal) => {
              const chosen = resolver.current?.choose(ordinal) ?? null;
              setDisambiguation(resolver.current?.pending() ?? null);
              return chosen;
            },
            clearPending: () => {
              resolver.current?.clearPending();
              setDisambiguation(null);
            },
          },
          executor: createActionExecutor({
            dispatcher: createRelayDispatcher(sendCdp),
            window,
            onStep: sendStep,
            captureEvidence,
          }),
          locator: createBinderLocator(snapshot),
          source,
          window,
          navRouteFor: buildNavRoutes(snapshot),
          onStep: sendStep,
        });
        lifecycle.controller = controller;
        controllerRef.current = controller;
        lifecycle.viewSub = controller.view.subscribe(setSpeculation);
      } catch (error: unknown) {
        console.warn('wispr: T1 embedding model unavailable', error);
      }
    })();

    return () => {
      lifecycle.cancelled = true;
      resolver.current = null;
      controllerRef.current = null;
      lifecycle.viewSub?.unsubscribe();
      lifecycle.controller?.dispose();
      lifecycle.built?.dispose();
      setSpeculation(IDLE_VIEW);
    };
  }, [engine, snapshot]);

  useEffect(() => {
    const connection = chrome.runtime.connect({ name: HUD_PORT });
    portRef.current = connection;
    setPort(connection);

    connection.onMessage.addListener((message: unknown) => {
      // Parsed, not trusted. This listener runs in a page the extension does not control.
      const next = parseWorkerMessage(message);
      if (next === null) return;

      if (next.kind === 'state') {
        setUpdate(next);
        return;
      }

      if (next.kind === 'voice') {
        setVoice(next);
        return;
      }

      if (next.kind === 'evidence_result') {
        const settle = captures.current.get(next.requestId);
        if (settle === undefined) return;
        captures.current.delete(next.requestId);
        // Validated on arrival: a malformed ref would be written into a timeline and fail the
        // gateway's own validation on the next flush, far from here.
        const refs: EvidenceRef[] = [];
        for (const candidate of next.refs) {
          const parsed = EvidenceRef.safeParse(candidate);
          if (parsed.success) refs.push(parsed.data);
        }
        settle(refs);
        return;
      }

      if (next.kind === 'escalate_result') {
        const settle = escalations.current.get(next.requestId);
        // No waiter means the escalation already timed out locally. Dropping the late reply is
        // right: the utterance it belonged to has moved on.
        if (settle === undefined) return;
        escalations.current.delete(next.requestId);

        if (!next.ok) {
          settle({ ok: false, reason: next.reason ?? 'unavailable' });
          return;
        }
        // Validated on arrival, like the snapshot: an unvalidated pick would reach the speculation
        // controller, and a malformed confidence there is a wrong click waiting to happen.
        const parsed = EscalateResponse.safeParse(next.response);
        settle(
          parsed.success ? { ok: true, response: parsed.data } : { ok: false, reason: 'not_found' },
        );
        return;
      }

      // A snapshot push. Validated against the contract before it is held — an unvalidated one
      // would be handed to the resolver and fail deep in a resolution rather than here.
      if (next.state === 'loaded') {
        const parsed = MemorySnapshot.safeParse(next.snapshot);
        setSnapshot(parsed.success ? parsed.data : null);
      } else {
        setSnapshot(null);
      }
    });

    connection.onDisconnect.addListener(() => {
      portRef.current = null;
      setPort(null);
      // Settle every escalation still waiting: the worker that owed them the answer is gone, and
      // an unsettled promise here would hang the utterance that is awaiting it.
      for (const settle of escalations.current.values())
        settle({ ok: false, reason: 'unavailable' });
      escalations.current.clear();
      setDisambiguation(null);
      // The worker was terminated or the extension reloaded. Showing the last known state would
      // claim an attachment that no longer exists.
      setUpdate(INITIAL_UPDATE);
      setVoice(INITIAL_VOICE);
      setSnapshot(null);
    });

    // Only the origin. A path can carry a record id, and CLAUDE.md § "PII rule" keeps that here.
    connection.postMessage({ kind: 'hello', origin: window.location.origin });

    return () => {
      portRef.current = null;
      connection.disconnect();
    };
  }, []);

  const send = useCallback(
    (kind: 'attach' | 'detach') => {
      port?.postMessage({ kind });
    },
    [port],
  );

  /**
   * Push-to-talk lives in the content script because the offscreen document that owns the
   * microphone sees no keyboard events — the page's key presses arrive here. The hotkey only
   * signals intent over the port; the worker brings the microphone up. It exists only while
   * attached: a page a tester has not attached to has no business listening for a talk key.
   */
  useEffect(() => {
    if (!attached || port === null) return undefined;

    const hotkey = createHotkey(
      window,
      { mode: DEFAULT_VOICE_SETTINGS.mode, keys: DEFAULT_VOICE_SETTINGS.hotkeyKeys },
      {
        onStart: () => {
          port.postMessage({ kind: 'voice_start' });
        },
        onStop: () => {
          port.postMessage({ kind: 'voice_stop' });
        },
      },
    );
    return () => {
      hotkey.dispose();
    };
  }, [attached, port]);

  /**
   * Drive the speculation controller from the voice snapshot.
   *
   * The worker distils the ASR stream into one {@link HudVoice}; this turns its transitions back
   * into the controller's event vocabulary — a fresh onset when the microphone opens, then each new
   * partial and the final by their monotonic revision. The controller does the rest: speculate on a
   * reversible target, stage a committing one, and never execute a class-C action from a partial.
   */
  useEffect(() => {
    const controller = controllerRef.current;
    if (controller === null) return;

    if (voice.phase === 'listening' && prevPhaseRef.current !== 'listening') {
      controller.onSpeechOnset();
      lastPartialRef.current = -1;
      lastFinalRef.current = -1;
    }
    prevPhaseRef.current = voice.phase;

    if (voice.partial !== null && voice.partial.revision > lastPartialRef.current) {
      lastPartialRef.current = voice.partial.revision;
      void controller.onPartial({
        revision: voice.partial.revision,
        transcript: voice.partial.text,
      });
    }
    if (voice.final !== null && voice.final.revision > lastFinalRef.current) {
      lastFinalRef.current = voice.final.revision;
      void controller.onFinal({ revision: voice.final.revision, transcript: voice.final.text });
    }
  }, [voice]);

  return (
    <Hud
      update={update}
      voice={voice}
      speculation={speculation}
      onConfirm={() => controllerRef.current?.confirm()}
      disambiguation={disambiguation}
      // A click takes the same road as speech: it feeds the controller the ordinal as a final
      // transcript, so the pick is parsed, resolved, classified and gated by exactly the code a
      // spoken "two" runs through. One path, one set of guarantees.
      onChoose={(ordinal) => {
        const revision = Math.max(lastPartialRef.current, lastFinalRef.current) + 1;
        lastFinalRef.current = revision;
        void controllerRef.current?.onFinal({
          revision,
          transcript: ORDINAL_WORD[ordinal] ?? String(ordinal),
        });
      }}
      onAttach={() => {
        send('attach');
      }}
      onDetach={() => {
        send('detach');
      }}
      origin={window.location.origin}
      version={version}
    />
  );
}

/** Mount, unless this document is not one a HUD belongs on. */
export function start(): void {
  // A content script is injected into every document, including the XML and SVG ones a browser
  // renders directly. There is nothing to attach to in those, and a HUD floating over an XML tree
  // is purely in the way. The root element's name is what distinguishes them — `document.body` is
  // typed non-nullable by the DOM lib even though it is absent here, so it cannot do the job.
  if (document.documentElement.localName !== 'html') return;

  const mounted = mountHudHost(document);
  const root = createRoot(mounted.container);
  root.render(
    <StrictMode>
      <HudApp version={__WISPR_VERSION__} hudHost={mounted.host} />
    </StrictMode>,
  );
}

start();
