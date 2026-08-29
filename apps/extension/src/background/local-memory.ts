import { MemorySnapshot } from 'protocol';
import { z } from 'zod';

/**
 * A dumped {@link MemorySnapshot} bound to the origin it was crawled from.
 *
 * Origin is *not* a field on the protocol snapshot — that contract is shared with the gateway
 * and the indexer, and a dump file is not a new deployable. The pair lives here so a developer
 * can load memory without a control plane, and so two dumps for two apps cannot attach to the
 * wrong tab.
 *
 * Stored in `chrome.storage.local`, never session: a dump is Product Memory (structure, not a
 * bearer token) and has to survive the service worker dying every thirty seconds. Tokens stay
 * in session storage (`token-store.ts`).
 */

export const LocalMemoryEnvelope = z.strictObject({
  origin: z.string().min(1),
  snapshot: MemorySnapshot,
});
export type LocalMemoryEnvelope = z.infer<typeof LocalMemoryEnvelope>;

/** The storage surface used here, narrowed so a test can supply one without a browser. */
export interface LocalStorageArea {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
  setAccessLevel?(options: {
    accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
  }): Promise<void>;
}

export interface LocalMemoryStore {
  read(): Promise<LocalMemoryEnvelope | null>;
  write(envelope: LocalMemoryEnvelope): Promise<void>;
  clear(): Promise<void>;
}

/** Namespaced so this area can hold other worker state without collision. */
export const LOCAL_MEMORY_KEY = 'wispr:local-memory';

/**
 * Reduce a typed URL (or a hostname) to the origin a content script will send on `hello`.
 *
 * `window.location.origin` is what the HUD reports. A dump of `https://app.example/login` has
 * to match the tab on `https://app.example/orders`, so the path is dropped and the scheme and
 * host are kept. `file:` and anything that is not http(s) is refused — those are not origins a
 * tester attaches to.
 */
export function canonicalOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export type LocalMemoryParseResult =
  | { readonly ok: true; readonly envelope: LocalMemoryEnvelope }
  | { readonly ok: false; readonly error: string };

/**
 * Accept either a protocol snapshot plus an origin, or the `{ origin, snapshot }` envelope
 * a developer wraps around a dump file.
 *
 * `originHint` wins when it is non-empty so the options page's origin field is the source of
 * truth for "which tab should this attach to", not a stale origin left in an old envelope.
 */
export function parseLocalMemory(input: unknown, originHint?: string): LocalMemoryParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'expected a JSON object' };
  }

  const record = input as Record<string, unknown>;
  const wrapped = 'snapshot' in record && 'origin' in record;
  const snapshotRaw = wrapped ? record.snapshot : input;

  const hint = originHint?.trim() ?? '';
  const originRaw =
    hint !== '' ? hint : wrapped && typeof record.origin === 'string' ? record.origin : undefined;

  if (originRaw === undefined) {
    return {
      ok: false,
      error: 'origin is required — type the page origin or include it in the file',
    };
  }

  const origin = canonicalOrigin(originRaw);
  if (origin === null) {
    return { ok: false, error: 'origin must be an http(s) URL' };
  }

  const parsed = MemorySnapshot.safeParse(snapshotRaw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => issue.path.join('.') || 'root')
      .slice(0, 6)
      .join(', ');
    return { ok: false, error: `snapshot is not a MemorySnapshot: ${detail}` };
  }

  return { ok: true, envelope: { origin, snapshot: parsed.data } };
}

/**
 * Counts only — never labels, never accessible names. A dump can carry redacted display
 * strings, and those do not belong in a status line that might be screenshot.
 */
export function snapshotCounts(snapshot: MemorySnapshot): {
  readonly screens: number;
  readonly elements: number;
} {
  return { screens: snapshot.screens.length, elements: snapshot.elements.length };
}

export function createLocalMemoryStore(area: LocalStorageArea): LocalMemoryStore {
  // Same guarantee as the token store, if this Chrome exposes the API on `local`: a content
  // script running in a page we do not control must not be able to read dumped memory out of
  // extension storage. Structure is less sensitive than a bearer token, and still not theirs.
  void area.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

  return {
    async read(): Promise<LocalMemoryEnvelope | null> {
      const stored = await area.get(LOCAL_MEMORY_KEY);
      const parsed = LocalMemoryEnvelope.safeParse(stored[LOCAL_MEMORY_KEY]);
      if (!parsed.success) return null;
      const origin = canonicalOrigin(parsed.data.origin);
      if (origin === null) return null;
      return { origin, snapshot: parsed.data.snapshot };
    },

    async write(envelope: LocalMemoryEnvelope): Promise<void> {
      const origin = canonicalOrigin(envelope.origin);
      if (origin === null) {
        throw new Error('origin must be an http(s) URL');
      }
      const parsed = MemorySnapshot.safeParse(envelope.snapshot);
      if (!parsed.success) {
        throw new Error('snapshot is not a MemorySnapshot');
      }
      await area.set({ [LOCAL_MEMORY_KEY]: { origin, snapshot: parsed.data } });
    },

    async clear(): Promise<void> {
      await area.remove(LOCAL_MEMORY_KEY);
    },
  };
}
