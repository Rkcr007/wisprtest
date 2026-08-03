import type { IndexProgressEvent } from 'protocol';
import { create } from 'zustand';

import { initialProgress, reduceProgress, type IndexProgressState } from './progress';

/**
 * Client state for the Indexing screen.
 *
 * Zustand rather than `useState`, per Phase 18's stack: the folded stream is read by the header
 * counters, the progress bar and the route table at once, and threading a reducer's state through
 * three levels of props is how those three drift out of step.
 *
 * The store holds only what arrives over the wire. Nothing here is fetched, derived from a guess,
 * or seeded with an example — an empty crawl renders as an empty crawl.
 */
export interface ProgressStore {
  readonly progress: IndexProgressState;
  /** Whether the `EventSource` currently has a connection. */
  readonly connected: boolean;
  /** Frames the console could not use, and transport drops. Shown, never silently swallowed. */
  readonly warnings: readonly string[];
  readonly apply: (event: IndexProgressEvent) => void;
  readonly markOpen: () => void;
  readonly markDisconnected: () => void;
  readonly markStreamError: () => void;
  readonly warn: (detail: string) => void;
  readonly reset: () => void;
}

const emptyState = {
  progress: initialProgress,
  connected: false,
  warnings: [] as readonly string[],
};

export const useProgressStore = create<ProgressStore>((set) => ({
  ...emptyState,

  apply: (event) => {
    set((store) => ({ progress: reduceProgress(store.progress, event) }));
  },

  markOpen: () => {
    set({ connected: true });
  },

  markDisconnected: () => {
    // Not a failure: `EventSource` retries and resumes from `Last-Event-ID`, so the crawl is
    // still being followed. The screen says "reconnecting", and the counters stay put.
    set((store) => ({
      connected: false,
      warnings: [...store.warnings, 'the connection dropped; reconnecting'],
    }));
  },

  markStreamError: () => {
    set((store) => ({
      connected: false,
      progress: { ...store.progress, phase: 'stream_error' },
    }));
  },

  warn: (detail) => {
    set((store) => ({ warnings: [...store.warnings, detail] }));
  },

  reset: () => {
    set(emptyState);
  },
}));
