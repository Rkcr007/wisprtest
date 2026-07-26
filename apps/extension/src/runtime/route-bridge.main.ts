import { installRouteBridge, type RuntimeWindow } from './route-bridge.js';

/**
 * Entry point of `dist/route-bridge.js`, injected by the manifest at `document_start` into the
 * MAIN world — the application's own JavaScript realm.
 *
 * Separate from `route-bridge.ts` so that the installer is a pure function its tests can call
 * against a constructed window, rather than a module whose import silently patches whichever
 * realm the test runner happens to be running in.
 *
 * `globalThis` is the page's `window` here. The cast is because this file is typechecked with
 * `WebWorker` in `lib`, where `globalThis` is not narrowed to a `Window`.
 */
installRouteBridge(globalThis as unknown as RuntimeWindow);
