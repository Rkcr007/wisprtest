import type { ExtensionToken } from 'protocol';

import {
  INITIAL_UPDATE,
  parseRequest,
  type AttachFailure,
  type AttachState,
  type HudUpdate,
} from '../messaging.js';
import { isUsable, type TokenClient } from './token-client.js';
import type { TokenStore } from './token-store.js';

/**
 * The attach state machine, and the per-tab sessions it drives.
 *
 * `detached → attaching → attached`, with `failed` as the fourth state the phase's brief does not
 * name but the product needs: a tester whose attach did not work has to be told *why* — sign in,
 * gateway down, application not registered — and given a way to try again. A machine with no
 * failure state reports a permanent "attaching…", which is the worst of the four.
 *
 * ## Attaching means authenticated
 *
 * `attached` is only reached once a scoped token is held. That is the honest reading: everything
 * the extension will do from here — load a memory snapshot, write back an alias, ingest a session
 * step — needs one, so a HUD claiming to be attached without a token would be claiming a
 * readiness it does not have.
 *
 * ## One session per tab, one token per origin
 *
 * State is per tab, because that is what a tester attaches and detaches. Tokens are cached per
 * origin, because two tabs open on the same application are the same application — and minting a
 * second token for the second tab would double the load on the control plane for nothing.
 */

/** The parts of `chrome.runtime.Port` used here. Narrowed so tests can supply one. */
export interface PortLike {
  readonly name: string;
  // `id` is `number | undefined` rather than optional, because that is the shape
  // `chrome.runtime.Port` declares and `exactOptionalPropertyTypes` does not conflate the two.
  readonly sender?: { readonly tab?: { readonly id?: number | undefined } | undefined } | undefined;
  postMessage(message: unknown): void;
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
  disconnect(): void;
}

/** The alarm surface used here. */
export interface AlarmScheduler {
  create(name: string, info: { when: number }): void;
  clear(name: string): Promise<boolean>;
}

export interface AttachControllerOptions {
  readonly tokens: TokenClient;
  readonly store: TokenStore;
  readonly alarms: AlarmScheduler;
  /** How far before expiry to refresh. Also the margin that makes a token "not usable yet". */
  readonly refreshMarginMs?: number;
  readonly now?: () => number;
  readonly onError?: (event: string, error: unknown) => void;
}

export interface AttachController {
  /** Register a HUD connection. The content script opens the port; the worker never initiates. */
  connect(port: PortLike): void;
  /** Toolbar button: attach if detached, detach if attached. */
  toggle(tabId: number): Promise<void>;
  /** An alarm fired. Refreshes the token for the tab it names, if that tab is still attached. */
  onAlarm(name: string): Promise<void>;
  /** Current state for a tab, for tests and for the health of the worker. */
  stateOf(tabId: number): AttachState;
}

interface Session {
  readonly port: PortLike;
  origin: string | null;
  state: AttachState;
  failure: AttachFailure | null;
  token: ExtensionToken | null;
}

/** Five minutes: long enough that a refresh cannot land after the token it replaces has died. */
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000;

const ALARM_PREFIX = 'wispr:refresh:';

export function alarmNameFor(tabId: number): string {
  return `${ALARM_PREFIX}${String(tabId)}`;
}

function tabIdFromAlarm(name: string): number | null {
  if (!name.startsWith(ALARM_PREFIX)) return null;
  const tabId = Number(name.slice(ALARM_PREFIX.length));
  return Number.isInteger(tabId) ? tabId : null;
}

export function createAttachController(options: AttachControllerOptions): AttachController {
  const {
    tokens,
    store,
    alarms,
    refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS,
    now = () => Date.now(),
    onError,
  } = options;

  const sessions = new Map<number, Session>();

  function publish(tabId: number): void {
    const session = sessions.get(tabId);
    if (session === undefined) return;

    const update: HudUpdate = {
      ...INITIAL_UPDATE,
      attach: session.state,
      failure: session.failure,
      // The HUD learns the token's *state*, never its value. See `messaging.ts`.
      token:
        session.state === 'attaching'
          ? 'refreshing'
          : session.token !== null
            ? 'valid'
            : session.state === 'failed'
              ? 'failed'
              : 'absent',
      tenantId: session.token?.tenantId ?? null,
      applicationId: session.token?.applicationId ?? null,
      tokenExpiresAt: session.token?.expiresAt ?? null,
    };

    try {
      session.port.postMessage(update);
    } catch (error: unknown) {
      // The tab navigated or closed between the state change and this push. Not an error worth
      // failing an attach over — the disconnect handler is about to clean the session up.
      onError?.('hud.post_failed', error);
    }
  }

  /** A cached token for this origin if one is still usable, otherwise a freshly minted one. */
  async function acquire(origin: string): Promise<ExtensionToken> {
    const cached = await store.read(origin);
    if (cached !== null && isUsable(cached, now(), refreshMarginMs)) return cached;

    const token = await tokens.fetchToken(origin);
    await store.write(origin, token);
    return token;
  }

  async function attach(tabId: number): Promise<void> {
    const session = sessions.get(tabId);
    if (session === undefined) return;
    // No `hello` yet: the content script has connected but not said where it is.
    if (session.origin === null) return;
    // Already in flight. A tester pressing the button twice should not mint two tokens.
    if (session.state === 'attaching') return;

    session.state = 'attaching';
    session.failure = null;
    publish(tabId);

    try {
      const token = await acquire(session.origin);

      // The tab may have detached or navigated while the request was in flight. Publishing an
      // `attached` state for a session that has since been torn down would leave a HUD claiming
      // a token that belongs to a page that no longer exists.
      const current = sessions.get(tabId);
      if (current === undefined) return;
      if (current.state !== 'attaching') return;

      current.token = token;
      current.state = 'attached';
      current.failure = null;
      publish(tabId);

      scheduleRefresh(tabId, token);
    } catch (error: unknown) {
      const current = sessions.get(tabId);
      if (current === undefined) return;

      // Fail closed: no token is kept, and the cached one is dropped rather than reused. A stale
      // credential that "usually works" is how an expired session becomes an unexplained 401 in
      // the middle of a command.
      current.token = null;
      current.state = 'failed';
      current.failure = failureOf(error);
      if (current.origin !== null) await store.clear(current.origin).catch(() => undefined);
      publish(tabId);
      onError?.('attach.failed', error);
    }
  }

  async function detach(tabId: number): Promise<void> {
    const session = sessions.get(tabId);
    if (session === undefined) return;

    session.state = 'detached';
    session.failure = null;
    session.token = null;
    await alarms.clear(alarmNameFor(tabId));
    publish(tabId);
  }

  function scheduleRefresh(tabId: number, token: ExtensionToken): void {
    // An alarm rather than a timer: a `setTimeout` dies with the service worker, which Chrome
    // terminates after ~30s idle. The refresh has to outlive that.
    const when = Math.max(now() + 1_000, Date.parse(token.expiresAt) - refreshMarginMs);
    alarms.create(alarmNameFor(tabId), { when });
  }

  return {
    connect(port: PortLike): void {
      const tabId = port.sender?.tab?.id;
      if (tabId === undefined) {
        // A port with no tab is not a HUD. Nothing else in this extension connects, so this is
        // either a bug or something we should not be talking to.
        port.disconnect();
        return;
      }

      const session: Session = {
        port,
        origin: null,
        state: 'detached',
        failure: null,
        token: null,
      };
      sessions.set(tabId, session);

      port.onMessage.addListener((message: unknown) => {
        const request = parseRequest(message);
        if (request === null) {
          onError?.('hud.message_invalid', message);
          return;
        }

        switch (request.kind) {
          case 'hello':
            session.origin = request.origin;
            publish(tabId);
            return;
          case 'attach':
            void attach(tabId);
            return;
          case 'detach':
            void detach(tabId);
            return;
        }
      });

      port.onDisconnect.addListener(() => {
        sessions.delete(tabId);
        void alarms.clear(alarmNameFor(tabId));
      });
    },

    async toggle(tabId: number): Promise<void> {
      const session = sessions.get(tabId);
      if (session === undefined) return;

      if (session.state === 'attached' || session.state === 'attaching') {
        await detach(tabId);
        return;
      }
      await attach(tabId);
    },

    async onAlarm(name: string): Promise<void> {
      const tabId = tabIdFromAlarm(name);
      if (tabId === null) return;

      const session = sessions.get(tabId);
      if (session === undefined) return;
      if (session.state !== 'attached') return;
      if (session.origin === null) return;

      // Drop the cached token first: `acquire` would otherwise hand back the very token this
      // refresh exists to replace, since it is still inside its usable window.
      await store.clear(session.origin);
      await attach(tabId);
    },

    stateOf(tabId: number): AttachState {
      return sessions.get(tabId)?.state ?? 'detached';
    },
  };
}

/** Map a thrown error to the closed set of reasons the HUD can phrase for a tester. */
function failureOf(error: unknown): AttachFailure {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (code === 'unauthenticated' || code === 'unreachable' || code === 'internal') return code;
  }
  return 'internal';
}
