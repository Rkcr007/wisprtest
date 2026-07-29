import { SessionStep } from 'protocol';

import type { BufferStore } from './buffer.js';

/**
 * Where buffered steps live while the service worker is not running.
 *
 * The same reasoning as `background/token-store.ts`, for a different payload:
 *
 * - **`chrome.storage.session`, not `local`.** Session storage is memory-backed, so a tester's
 *   utterances and the elements they touched never reach disk, and they are gone when the browser
 *   closes. A session that outlived the browser would be a timeline nobody is going to flush
 *   anyway — and a record of a customer's application sitting in a file.
 * - **Closed to content scripts.** `TRUSTED_CONTEXTS` is the default and is set explicitly because
 *   it is load-bearing: the content script runs in a page the extension does not control, and a
 *   buffered step carries the redacted utterance and the element keys of the app under test.
 *
 * Steps are validated on the way back in. Storage is not a trust boundary in the usual sense, but
 * a shape that has been through a serialise/restore cycle and an extension upgrade is exactly the
 * kind of thing that turns out not to match the contract any more — and a malformed step would
 * otherwise fail deep inside a flush, long after the code that wrote it.
 */

/** The storage surface used here, narrowed so a test can supply one without a browser. */
export interface SessionStorageArea {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
  setAccessLevel?(options: {
    accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
  }): Promise<void>;
}

/** Keys are namespaced so this area can hold other worker state without collision. */
export function bufferKey(sessionId: string): string {
  return `wispr:steps:${sessionId}`;
}

export function createBufferStore(
  area: SessionStorageArea,
  onError?: (error: unknown) => void,
): BufferStore {
  // Stated rather than assumed. It is already the default, but a future change to the manifest or
  // to Chrome's defaults must not quietly open a tester's session history to the page.
  void area
    .setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch((error: unknown) => onError?.(error));

  return {
    async read(sessionId): Promise<readonly SessionStep[]> {
      const key = bufferKey(sessionId);
      const held = await area.get(key);
      const raw = held[key];
      if (!Array.isArray(raw)) return [];

      const steps: SessionStep[] = [];
      for (const candidate of raw) {
        const parsed = SessionStep.safeParse(candidate);
        // One malformed step does not discard the rest: the others are still a tester's history,
        // and dropping a whole session over one bad row is the larger loss.
        if (parsed.success) steps.push(parsed.data);
        else onError?.(parsed.error);
      }
      return steps;
    },

    async write(sessionId, steps): Promise<void> {
      await area.set({ [bufferKey(sessionId)]: steps });
    },

    async clear(sessionId): Promise<void> {
      await area.remove(bufferKey(sessionId));
    },
  };
}
