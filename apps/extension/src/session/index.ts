/**
 * Sessions — the record of what a tester did, and the evidence behind it.
 *
 * Every action emits a `SessionStep` (the executor and the speculation controller both do, from
 * Phase 10). This is where those steps are buffered, survive a service-worker restart, and reach
 * the control plane in batches — and where the evidence captured on checks and failures is
 * serialised and redacted before any of it leaves the browser.
 *
 * Nothing here is on the hot path. A step is recorded after the action it describes has already
 * run, and a flush that fails costs a retry rather than a command.
 */
export { createSessionBuffer } from './buffer.js';
export type { BufferStore, SessionBuffer, SessionBufferOptions, StepSender } from './buffer.js';
export { createBufferStore, bufferKey } from './store.js';
export type { SessionStorageArea } from './store.js';
export {
  captureRegion,
  containingLandmark,
  contentHash,
  evidenceRef,
  serializeRedacted,
  shouldCapture,
} from './evidence.js';
export type { CaptureRegion, SnapshotOptions } from './evidence.js';
