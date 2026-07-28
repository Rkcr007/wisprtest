import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { MemorySnapshot, type ResolutionResult } from 'protocol';

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
import { createBrowserEmbedder, createResolver, type Resolver } from '../resolver/index.js';
import { createRuntimeStateEngine, type RuntimeStateEngine } from '../runtime/index.js';
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
const NOT_FOUND: ResolutionResult = { outcome: 'not_found', tier: 'T1', latencyMs: 0, candidates: [] };

/**
 * Relay one CDP command to the service worker and await its acknowledgement.
 *
 * `chrome.debugger` is unreachable from a content script, so the executor's trusted dispatch goes
 * worker-side; this awaits the reply so a command the worker could not run rejects here and the
 * executor records a failed action rather than a silent miss.
 */
async function sendCdp(command: CdpCommand): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage({ type: CDP_MESSAGE, command });
  if (typeof response !== 'object' || response === null || (response as { ok?: unknown }).ok !== true) {
    const error = (response as { error?: unknown } | null)?.error;
    throw new Error(typeof error === 'string' ? error : 'cdp dispatch failed');
  }
}

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
  // Transition tracking, so the voice snapshot below drives one onset/partial/final per change.
  const prevPhaseRef = useRef<HudVoice['phase']>('idle');
  const lastPartialRef = useRef(-1);
  const lastFinalRef = useRef(-1);
  const attached = update.attach === 'attached';

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
        lifecycle.built = createResolver({ snapshot, embedder, source });
        resolver.current = lifecycle.built;

        // The runtime loop: parse → resolve → speculate/stage → commit → execute, all in-process.
        // The executor's trusted dispatch is relayed to the worker, which owns `chrome.debugger`.
        const controller = createSpeculationController({
          parser: createIntentParser({ vocabulary: buildIntentVocabulary(snapshot) }),
          resolver: {
            resolve: (phrase) => resolver.current?.resolve(phrase) ?? Promise.resolve(NOT_FOUND),
          },
          executor: createActionExecutor({ dispatcher: createRelayDispatcher(sendCdp), window }),
          locator: createBinderLocator(snapshot),
          source,
          window,
          navRouteFor: buildNavRoutes(snapshot),
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
      setPort(null);
      // The worker was terminated or the extension reloaded. Showing the last known state would
      // claim an attachment that no longer exists.
      setUpdate(INITIAL_UPDATE);
      setVoice(INITIAL_VOICE);
      setSnapshot(null);
    });

    // Only the origin. A path can carry a record id, and CLAUDE.md § "PII rule" keeps that here.
    connection.postMessage({ kind: 'hello', origin: window.location.origin });

    return () => {
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
        onStart: () => port.postMessage({ kind: 'voice_start' }),
        onStop: () => port.postMessage({ kind: 'voice_stop' }),
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
      void controller.onPartial({ revision: voice.partial.revision, transcript: voice.partial.text });
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
