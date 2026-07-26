import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { HUD_PORT, INITIAL_UPDATE, parseUpdate, type HudUpdate } from '../messaging.js';
import { createRuntimeStateEngine, type RuntimeStateEngine } from '../runtime/index.js';
import { Hud } from './Hud.js';
import { mountHudHost } from './mount.js';

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
  const [port, setPort] = useState<chrome.runtime.Port | null>(null);

  /**
   * The engine, while attached.
   *
   * Held in a ref rather than in state because nothing rendered depends on it — re-rendering the
   * HUD when the engine appears would be a render for no visible reason. Phase 8's resolver
   * subscribes to `engine.state` and reads `engine.scopedIndex`; this phase's job is that the
   * engine exists, runs against the real page, and is torn down cleanly.
   */
  const engine = useRef<RuntimeStateEngine | null>(null);
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
    engine.current = started;

    return () => {
      engine.current = null;
      started.dispose();
    };
  }, [attached, hudHost]);

  useEffect(() => {
    const connection = chrome.runtime.connect({ name: HUD_PORT });
    setPort(connection);

    connection.onMessage.addListener((message: unknown) => {
      // Parsed, not trusted. This listener runs in a page the extension does not control.
      const next = parseUpdate(message);
      if (next !== null) setUpdate(next);
    });

    connection.onDisconnect.addListener(() => {
      setPort(null);
      // The worker was terminated or the extension reloaded. Showing the last known state would
      // claim an attachment that no longer exists.
      setUpdate(INITIAL_UPDATE);
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

  return (
    <Hud
      update={update}
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
