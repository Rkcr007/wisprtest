/**
 * The CDP dispatch seam.
 *
 * docs/ARCHITECTURE.md § 3: the executor "dispatches trusted events via CDP
 * (`Input.dispatchKeyEvent`, `Input.dispatchMouseEvent`) rather than synthetic DOM events, so apps
 * that check `isTrusted` behave correctly." A synthetic `new MouseEvent('click')` carries
 * `isTrusted === false`, and a bank's approve button — the exact class-C action the taxonomy
 * guards — is entitled to refuse it. Only the browser, driven over the DevTools protocol, produces
 * a trusted one.
 *
 * ## Two implementations of one interface, and where each runs
 *
 * {@link CdpDispatcher} is the interface the {@link ActionExecutor} depends on. It is deliberately
 * the whole surface — `mouse` and `key` — so a test can supply a fake and assert the exact command
 * stream, the same seam the repo uses for `StreamingAsr`, `Embedder` and the token socket.
 *
 * - **In the extension**, `chrome.debugger` lives in the service worker, not the content script,
 *   so the executor (content script) cannot call it directly. {@link createRelayDispatcher} sends
 *   each command to the worker, which runs it against the attached tab through
 *   {@link runCdpCommand}. That worker side is `background/cdp-dispatch.ts`.
 * - **In the command e2e**, Playwright's `CDPSession` exposes the identical
 *   `send(method, params)` shape as `chrome.debugger.sendCommand`, so {@link createDebuggerDispatcher}
 *   drives the real protocol in a real browser without the extension round trip — proving the
 *   commands this module builds actually produce trusted input.
 *
 * Neither path crosses the network (CLAUDE.md rule #2): the content→worker hop is in-process
 * messaging within the one extension, and the protocol commands never leave the browser.
 */

export type MouseButton = 'left' | 'right' | 'middle' | 'none';

export interface CdpMouseEvent {
  readonly type: 'mousePressed' | 'mouseReleased' | 'mouseMoved';
  /** CSS pixels from the top-left of the layout viewport, as `Input.dispatchMouseEvent` wants. */
  readonly x: number;
  readonly y: number;
  readonly button: MouseButton;
  readonly clickCount: number;
}

export interface CdpKeyEvent {
  readonly type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
  readonly key?: string;
  readonly code?: string;
  /** The character to insert. On a `keyDown`, this is what actually types the glyph. */
  text?: string;
  unmodifiedText?: string;
  windowsVirtualKeyCode?: number;
}

export interface CdpDispatcher {
  mouse(event: CdpMouseEvent): Promise<void>;
  key(event: CdpKeyEvent): Promise<void>;
}

/** A single relayed command, content script → service worker. */
export type CdpCommand =
  | { readonly kind: 'mouse'; readonly event: CdpMouseEvent }
  | { readonly kind: 'key'; readonly event: CdpKeyEvent };

/** The runtime-message discriminator the worker filters on. */
export const CDP_MESSAGE = 'wispr:cdp';

/** A `sendCommand(method, params)` transport — `chrome.debugger` and Playwright's CDPSession both fit. */
export type SendCommand = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** The centre of an element in layout-viewport CSS pixels — where a click or focus is aimed. */
export function viewportPoint(element: Element): { readonly x: number; readonly y: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(0, rect.left + rect.width / 2),
    y: Math.max(0, rect.top + rect.height / 2),
  };
}

/** Protocol params for a mouse event. Exported so tests and the e2e assert the exact shape. */
export function mouseParams(event: CdpMouseEvent): Record<string, unknown> {
  return {
    type: event.type,
    x: event.x,
    y: event.y,
    button: event.button,
    clickCount: event.clickCount,
    // A pressed left button is reported in the bitfield too; some renderers read it for drags.
    buttons: event.button === 'left' && event.type === 'mousePressed' ? 1 : 0,
  };
}

/** Protocol params for a key event; undefined fields are dropped so the payload stays minimal. */
export function keyParams(event: CdpKeyEvent): Record<string, unknown> {
  const params: Record<string, unknown> = { type: event.type };
  if (event.key !== undefined) params.key = event.key;
  if (event.code !== undefined) params.code = event.code;
  if (event.text !== undefined) params.text = event.text;
  if (event.unmodifiedText !== undefined) params.unmodifiedText = event.unmodifiedText;
  if (event.windowsVirtualKeyCode !== undefined) {
    params.windowsVirtualKeyCode = event.windowsVirtualKeyCode;
  }
  return params;
}

/**
 * A dispatcher over a raw `sendCommand` transport — the direct CDP path.
 *
 * Used by the command e2e with a Playwright `CDPSession`, and by the worker side to run relayed
 * commands (see {@link runCdpCommand}, which shares the same translation).
 */
export function createDebuggerDispatcher(sendCommand: SendCommand): CdpDispatcher {
  return {
    async mouse(event): Promise<void> {
      await sendCommand('Input.dispatchMouseEvent', mouseParams(event));
    },
    async key(event): Promise<void> {
      await sendCommand('Input.dispatchKeyEvent', keyParams(event));
    },
  };
}

/** Run one relayed command against a `sendCommand` transport. The worker's half of the relay. */
export async function runCdpCommand(sendCommand: SendCommand, command: CdpCommand): Promise<void> {
  const dispatcher = createDebuggerDispatcher(sendCommand);
  if (command.kind === 'mouse') await dispatcher.mouse(command.event);
  else await dispatcher.key(command.event);
}

/**
 * The content-script dispatcher: every command is forwarded to the worker, which owns
 * `chrome.debugger`. `send` awaits the worker's acknowledgement, so a dispatch that the worker
 * could not run (the debugger failed to attach, say) rejects here and the executor records a
 * failed action rather than a silent miss.
 */
export function createRelayDispatcher(send: (command: CdpCommand) => Promise<void>): CdpDispatcher {
  return {
    mouse: (event) => send({ kind: 'mouse', event }),
    key: (event) => send({ kind: 'key', event }),
  };
}
