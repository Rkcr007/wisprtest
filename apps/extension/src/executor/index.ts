/**
 * The executor — trusted dispatch against the application under test (docs/BUILD-PLAN.md Phase 10).
 *
 * `createActionExecutor` is the single entry point. It dispatches the trust-sensitive verbs through
 * a {@link CdpDispatcher} so `isTrusted` holds, does the rest with the plain DOM API, and emits a
 * {@link SessionStep} for every action. The dispatcher is an interface with two implementations —
 * the content→worker relay in the extension, and a direct `sendCommand` transport the command e2e
 * drives through Playwright's CDPSession — so the exact protocol commands can be asserted in a unit
 * test and proven trusted in a real browser.
 */

export { createActionExecutor } from './executor.js';
export type { ActionExecutor, DispatchContext, ExecutorOptions } from './executor.js';
export {
  CDP_MESSAGE,
  createDebuggerDispatcher,
  createRelayDispatcher,
  keyParams,
  mouseParams,
  runCdpCommand,
  viewportPoint,
} from './cdp.js';
export type {
  CdpCommand,
  CdpDispatcher,
  CdpKeyEvent,
  CdpMouseEvent,
  MouseButton,
  SendCommand,
} from './cdp.js';
export { ENTER_KEY, ENTER_KEY_UP, keyEventsForChar } from './keymap.js';
