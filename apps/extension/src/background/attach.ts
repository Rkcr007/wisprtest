import { AliasWriteback, EscalateRequest, type ExtensionToken } from 'protocol';

import {
  INITIAL_UPDATE,
  parseRequest,
  type AttachFailure,
  type AttachState,
  type HudEscalateResult,
  type HudSnapshot,
  type HudUpdate,
  type SnapshotState,
} from '../messaging.js';
import { createWritebackQueue, type WritebackQueue } from '../resolver/index.js';
import type { AliasClient } from './alias-client.js';
import type { EscalateClient } from './escalate-client.js';
import type { MemoryClient } from './memory-client.js';
import { isUsable, type TokenClient } from './token-client.js';
import type { TokenStore } from './token-store.js';
import type { VoiceController } from './voice-controller.js';

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
  /**
   * Loads and holds the memory snapshot. Optional so the token lifecycle can be tested in
   * isolation; when present, a successful attach fetches the snapshot and pushes it to the HUD,
   * and a `refetch_snapshot` request reloads it out of band.
   */
  readonly memory?: MemoryClient;
  /**
   * The voice pipeline's worker half. Optional so the attach lifecycle can be tested in isolation;
   * when present, the HUD's push-to-talk requests are relayed to it and its transcript state is
   * pushed back over the same port.
   */
  readonly voice?: VoiceController;
  /**
   * The T2 escalation client. Optional so the attach lifecycle can be tested in isolation; without
   * it an `escalate` request is answered `unavailable` and the content script disambiguates —
   * which is also what a tab with no token gets, and is the correct degraded behaviour.
   */
  readonly escalation?: EscalateClient;
  /**
   * The alias write-back client. Optional for the same reason; without it the queue is not created
   * and write-backs are dropped, so the extension resolves but stops learning.
   */
  readonly aliases?: AliasClient;
  /** Flush cadence for the write-back queue. 10s per docs/BUILD-PLAN.md Phase 11. */
  readonly writebackIntervalMs?: number;
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
  /** The memory version this tab's aliases are learned against; set when the snapshot loads. */
  memoryVersionId: string | null;
  /** Holds learned aliases and flushes them in batches. Created with the snapshot. */
  writebacks: WritebackQueue | null;
  /**
   * The token the final flush uses, frozen at detach.
   *
   * Detach clears `token` synchronously, but the flush it triggers is in flight for as long as the
   * request takes. Without this the last batch of a session — the one holding everything learned
   * since the previous tick — would find no credential and be thrown away.
   */
  flushToken: string | null;
}

/** Five minutes: long enough that a refresh cannot land after the token it replaces has died. */
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000;

/** Ten seconds, per docs/BUILD-PLAN.md Phase 11. */
const DEFAULT_WRITEBACK_INTERVAL_MS = 10_000;

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
    memory,
    voice,
    escalation,
    aliases,
    writebackIntervalMs = DEFAULT_WRITEBACK_INTERVAL_MS,
    refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS,
    now = () => Date.now(),
    onError,
  } = options;

  const sessions = new Map<number, Session>();

  /** Post a snapshot state to the HUD, tolerating a tab that navigated away mid-flight. */
  function postSnapshot(session: Session, message: HudSnapshot): void {
    try {
      session.port.postMessage(message);
    } catch (error: unknown) {
      onError?.('snapshot.post_failed', error);
    }
  }

  function snapshotMessage(
    state: SnapshotState,
    applicationId: string | null,
    memoryVersionId: string | null,
    snapshot?: unknown,
  ): HudSnapshot {
    return { kind: 'snapshot', state, applicationId, memoryVersionId, snapshot };
  }

  /**
   * Fetch the snapshot for an attached tab and push it to its HUD.
   *
   * A no-op without a memory client. An origin that matches no registered application has a token
   * with `applicationId: null` and simply has nothing to load — reported as `absent`, not an
   * error, so the HUD says "not indexed" rather than showing a failure for a normal page.
   */
  async function loadSnapshot(tabId: number): Promise<void> {
    if (memory === undefined) return;
    const session = sessions.get(tabId);
    if (session?.token == null) return;

    const applicationId = session.token.applicationId;
    if (applicationId === null) {
      postSnapshot(session, snapshotMessage('absent', null, null));
      return;
    }

    postSnapshot(session, snapshotMessage('loading', applicationId, null));

    try {
      const snapshot = await memory.load(applicationId, session.token.token);

      // The tab may have detached while the fetch was in flight; pushing a snapshot to a session
      // that is gone would revive a HUD for a page that no longer exists.
      const current = sessions.get(tabId);
      if (current?.state !== 'attached') return;

      if (snapshot === null) {
        closeWritebacks(current);
        postSnapshot(current, snapshotMessage('absent', applicationId, null));
        return;
      }
      // The queue opens with the snapshot, because the memory version it writes against is what
      // the snapshot just named. Before this point there is nothing an alias could be scoped to.
      openWritebacks(current, snapshot.memoryVersion.id);
      postSnapshot(
        current,
        snapshotMessage('loaded', applicationId, snapshot.memoryVersion.id, snapshot),
      );
    } catch (error: unknown) {
      const current = sessions.get(tabId);
      if (current?.state === 'attached') {
        postSnapshot(current, snapshotMessage('failed', applicationId, null));
      }
      onError?.('snapshot.load_failed', error);
    }
  }

  /**
   * Give a tab a write-back queue for the memory version its snapshot just loaded.
   *
   * One queue per (tab, memory version): an alias learned against one version does not silently
   * migrate to the next — that is a decision the next version's approval makes (Phase 17) — so a
   * version change closes the old queue, flushing what it holds against the version it was learned
   * on, and opens a new one.
   */
  function openWritebacks(session: Session, memoryVersionId: string): void {
    if (aliases === undefined) return;
    if (session.memoryVersionId === memoryVersionId && session.writebacks !== null) return;

    const previous = session.writebacks;
    if (previous !== null) void previous.close().catch(() => undefined);

    session.memoryVersionId = memoryVersionId;
    session.writebacks = createWritebackQueue({
      intervalMs: writebackIntervalMs,
      send: async (items) => {
        // Read at send time, not at construction: a flush ten seconds later must use whatever
        // token the refresh alarm has since put in place, not the one this queue opened with.
        // `flushToken` covers the detach flush, which runs after `token` has been cleared.
        const token = session.token?.token ?? session.flushToken ?? undefined;
        if (token === undefined) {
          // Detached mid-flush. Throwing keeps the batch queued rather than discarding learning
          // that a re-attach could still persist.
          throw new Error('no token for alias write-back');
        }
        await aliases.write(memoryVersionId, items, token);
      },
      onError: (error) => {
        onError?.('alias.flush_failed', error);
      },
    });
  }

  /** Flush and drop a tab's queue — detach, disconnect, or a memory version going away. */
  function closeWritebacks(session: Session): void {
    const queue = session.writebacks;
    if (queue === null) return;
    session.writebacks = null;
    session.memoryVersionId = null;
    // Frozen before the caller clears the token out from under the flush.
    session.flushToken = session.token?.token ?? session.flushToken;
    // The "and on detach" flush. Fire-and-forget: detach must not wait on the control plane, and
    // a failure is already reported through `onError`.
    void queue.close().catch((error: unknown) => {
      onError?.('alias.flush_failed', error);
    });
  }

  /** Run one escalation for a tab and post the outcome back over its port. */
  async function escalate(session: Session, requestId: string, body: unknown): Promise<void> {
    const reply = (ok: boolean, response: unknown, reason: HudEscalateResult['reason']): void => {
      try {
        session.port.postMessage({ kind: 'escalate_result', requestId, ok, response, reason });
      } catch (error: unknown) {
        onError?.('escalate.post_failed', error);
      }
    };

    const token = session.token?.token;
    // No client or no session: the answer is that T2 is unavailable, and the content script shows
    // the T1 candidates. Never an error — a tester who has not attached still gets two tiers.
    if (escalation === undefined || token === undefined || session.state !== 'attached') {
      reply(false, undefined, 'unavailable');
      return;
    }

    const parsed = EscalateRequest.safeParse(body);
    if (!parsed.success) {
      // A malformed request from a content script is a bug on our side or a message from something
      // else in the page. Either way it does not reach the gateway or spend a tenant's budget.
      onError?.('escalate.invalid_request', parsed.error);
      reply(false, undefined, 'unavailable');
      return;
    }

    try {
      const outcome = await escalation.escalate(parsed.data, token);
      if (outcome.ok) reply(true, outcome.response, null);
      else reply(false, undefined, outcome.reason);
    } catch (error: unknown) {
      onError?.('escalate.failed', error);
      reply(false, undefined, 'unavailable');
    }
  }

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
      // The snapshot load is off the attach path: the HUD reaches `attached` as soon as the token
      // is held, and memory streams in behind it rather than gating the panel on a fetch.
      void loadSnapshot(tabId);
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

    // Flush before the token goes: this is the phase's "and on detach", and it is the last chance
    // to persist what this session learned. Closed first, while `session.token` is still set.
    closeWritebacks(session);

    // Drop the held snapshot with the token that fetched it: a detached tab keeps no memory.
    if (session.token?.applicationId != null) memory?.invalidate(session.token.applicationId);

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
        memoryVersionId: null,
        writebacks: null,
        flushToken: null,
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
          case 'refetch_snapshot': {
            // The content script found its snapshot stale. Drop the held copy and reload; the
            // tester keeps working against the old one until the new one arrives.
            const applicationId = session.token?.applicationId;
            if (applicationId != null) memory?.invalidate(applicationId);
            void loadSnapshot(tabId);
            return;
          }
          case 'voice_start':
            // Only an attached tab may open the microphone: capture needs a session, and the ASR
            // credential is minted against the same authenticated context the token gives.
            if (session.state === 'attached') void voice?.start(port);
            return;
          case 'voice_stop':
            void voice?.stop(port);
            return;
          case 'escalate':
            void escalate(session, request.requestId, request.request);
            return;
          case 'alias_writeback': {
            // Validated here, at the trust boundary: this arrives from a content script running in
            // a page the extension does not control, and an unvalidated write-back would be a
            // stranger's phrase persisted into a tenant's vocabulary.
            const parsed = AliasWriteback.safeParse(request.writeback);
            if (!parsed.success) {
              onError?.('alias.invalid_writeback', parsed.error);
              return;
            }
            session.writebacks?.enqueue(parsed.data);
            return;
          }
        }
      });

      port.onDisconnect.addListener(() => {
        voice?.release(port);
        // The tab navigated or closed. Whatever it learned is still worth persisting — this is the
        // same final flush detach performs, for the tester who just closed the tab instead.
        closeWritebacks(session);
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
