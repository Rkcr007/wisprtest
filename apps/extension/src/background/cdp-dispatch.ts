import {
  CDP_MESSAGE,
  runCdpCommand,
  type CdpCommand,
  type SendCommand,
} from '../executor/index.js';

/**
 * The worker half of CDP dispatch.
 *
 * The executor runs in the content script, where `chrome.debugger` is unavailable, so it relays
 * each command here (executor/cdp.ts). This service owns the debugger session: it attaches to the
 * sender's tab on first use, replays the relayed command through `Input.dispatch*`, and reports
 * success or a reason back so a dispatch that could not run surfaces as a failed action rather than
 * a silent miss.
 *
 * ## Why a whole tab gets a debugger banner
 *
 * Attaching the debugger shows Chrome's "WisprTest is debugging this browser" bar. That is not a
 * side effect to hide — it is the honest cost of producing *trusted* input (docs/ARCHITECTURE.md
 * § 3), and it is the only MV3 way to do so. The session is attached lazily, on the first dispatch,
 * and released when the tab goes away, so a tab a tester never issues a command on never sees it.
 */

/** The subset of `chrome.debugger` this needs, as an interface so the service is testable. */
export interface DebuggerApi {
  attach(target: { tabId: number }, requiredVersion: string): Promise<void>;
  detach(target: { tabId: number }): Promise<void>;
  sendCommand(
    target: { tabId: number },
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
}

/** The message the content script sends per relayed command. */
export interface CdpMessage {
  readonly type: typeof CDP_MESSAGE;
  readonly command: CdpCommand;
}

export type CdpResponse = { ok: true } | { ok: false; error: string };

/** A region of the page to photograph, in CSS pixels. */
export interface ScreenshotClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CdpDispatchService {
  /** Capture one clipped PNG, base64-encoded. Null when the capture could not be made. */
  captureScreenshot(tabId: number, clip: ScreenshotClip): Promise<string | null>;
  /** Handle a relayed command from `sender`, attaching if needed. */
  handle(message: unknown, tabId: number | undefined): Promise<CdpResponse>;
  /** Release the debugger session for a tab that has gone away. */
  release(tabId: number): void;
  /** Whether a message is one of ours, so the worker's listener can ignore the rest. */
  isCdpMessage(message: unknown): message is CdpMessage;
}

/** The DevTools protocol version the Input domain lives in. */
const PROTOCOL_VERSION = '1.3';

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'cdp dispatch failed';
}

export function createCdpDispatchService(debuggerApi: DebuggerApi): CdpDispatchService {
  const attached = new Set<number>();

  async function ensureAttached(tabId: number): Promise<void> {
    if (attached.has(tabId)) return;
    try {
      await debuggerApi.attach({ tabId }, PROTOCOL_VERSION);
    } catch (error: unknown) {
      // Another dispatch may have attached between the check and here — that is not a failure.
      if (!describe(error).includes('already attached')) throw error;
    }
    attached.add(tabId);
  }

  function isCdpMessage(message: unknown): message is CdpMessage {
    return (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === CDP_MESSAGE
    );
  }

  return {
    isCdpMessage,

    /**
     * Capture the target region as a PNG, over the attachment dispatch already holds.
     *
     * `Page.captureScreenshot` with a `clip` rather than `chrome.tabs.captureVisibleTab`: the
     * debugger is attached anyway for trusted input (Phase 10), so this needs no extra manifest
     * permission, and it photographs the element's own rectangle instead of the whole viewport —
     * less of a customer's screen leaves the browser for the same evidential value.
     */
    async captureScreenshot(tabId, clip): Promise<string | null> {
      try {
        await ensureAttached(tabId);
        const result = await debuggerApi.sendCommand({ tabId }, 'Page.captureScreenshot', {
          format: 'png',
          // `captureBeyondViewport: false` keeps the capture to what the tester could actually
          // see; scale 1 keeps it to what the page actually rendered.
          clip: { ...clip, scale: 1 },
          captureBeyondViewport: false,
        });
        const data = (result as { data?: unknown } | undefined)?.data;
        return typeof data === 'string' ? data : null;
      } catch {
        // Evidence is best-effort by design: a step recorded without a screenshot is still a step,
        // and failing the action because a capture failed would be the wrong trade.
        attached.delete(tabId);
        return null;
      }
    },

    async handle(message, tabId): Promise<CdpResponse> {
      if (!isCdpMessage(message)) return { ok: false, error: 'not a cdp message' };
      if (tabId === undefined) return { ok: false, error: 'no tab to dispatch to' };

      try {
        await ensureAttached(tabId);
        const sendCommand: SendCommand = (method, params) =>
          debuggerApi.sendCommand({ tabId }, method, params);
        await runCdpCommand(sendCommand, message.command);
        return { ok: true };
      } catch (error: unknown) {
        // A failed dispatch may mean the session died; drop it so the next command re-attaches.
        attached.delete(tabId);
        return { ok: false, error: describe(error) };
      }
    },

    release(tabId): void {
      if (!attached.has(tabId)) return;
      attached.delete(tabId);
      void debuggerApi.detach({ tabId }).catch(() => undefined);
    },
  };
}
