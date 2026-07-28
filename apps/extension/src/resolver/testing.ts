import { computeFingerprint, type PageContext } from 'fingerprint';
import type {
  Alias,
  ElementKey,
  ElementRecord,
  MemorySnapshot,
  MemoryVersion,
  ScreenNode,
} from 'protocol';

import { normalize, type Embedder } from './embedder.js';

/**
 * Helpers shared by the resolver's unit suites.
 *
 * Not a `.test.ts`, so vitest does not run it, and never imported by an extension entry point, so
 * the bundler never ships it. It builds contract-valid `MemorySnapshot`s from a live happy-dom
 * document using the *shared* fingerprint package — the same `computeFingerprint` the indexer
 * wrote the real records with (CLAUDE.md rule #4) — so a unit test resolves against memory shaped
 * exactly as production memory is.
 */

let counter = 0;
function uuid(): string {
  // Deterministic, valid v4-shaped ids: `crypto.randomUUID` exists in happy-dom, but a stable
  // sequence makes a failing assertion legible.
  counter += 1;
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

const TENANT_ID = uuid();
const APPLICATION_ID = uuid();
const MEMORY_VERSION_ID = uuid();
const HASH = 'a'.repeat(64);

export interface ElementSpec {
  readonly element: Element;
  readonly elementKey: ElementKey;
}

export interface ScreenSpec {
  readonly stateFingerprint: string;
  readonly routePattern: string;
  readonly label: string;
  readonly elements: readonly ElementSpec[];
}

export interface AliasSpec {
  readonly phrase: string;
  readonly elementId: string;
  readonly stateFingerprint?: string | null;
  readonly source?: Alias['source'];
  readonly hits?: number;
}

export interface BuiltSnapshot {
  readonly snapshot: MemorySnapshot;
  /** Element id by element key, so a test can name the element an alias should point at. */
  readonly idByKey: Map<string, string>;
}

/** Assemble a `MemorySnapshot` from live elements, fingerprinting each with the shared package. */
export function buildSnapshot(
  screens: readonly ScreenSpec[],
  aliases: readonly AliasSpec[] = [],
  context: PageContext = {},
): BuiltSnapshot {
  const memoryVersion: MemoryVersion = {
    id: MEMORY_VERSION_ID,
    tenantId: TENANT_ID,
    applicationId: APPLICATION_ID,
    version: 1,
    status: 'active',
    createdAt: '2026-07-27T00:00:00.000Z',
    approvedBy: uuid(),
    failureReason: null,
  };

  const screenNodes: ScreenNode[] = [];
  const elements: ElementRecord[] = [];
  const idByKey = new Map<string, string>();

  for (const screen of screens) {
    const screenId = uuid();
    screenNodes.push({
      id: screenId,
      memoryVersionId: MEMORY_VERSION_ID,
      routePattern: screen.routePattern,
      stateFingerprint: screen.stateFingerprint,
      label: screen.label,
      structuralHash: HASH,
      indexedAt: '2026-07-27T00:00:00.000Z',
    });

    for (const spec of screen.elements) {
      const id = uuid();
      idByKey.set(spec.elementKey, id);
      elements.push({
        id,
        screenId,
        elementKey: spec.elementKey,
        fingerprint: computeFingerprint(spec.element, context),
        confidence: 0.95,
        stability: 0.9,
      });
    }
  }

  const aliasRows: Alias[] = aliases.map((alias) => ({
    id: uuid(),
    tenantId: TENANT_ID,
    memoryVersionId: MEMORY_VERSION_ID,
    phrase: alias.phrase,
    elementId: alias.elementId,
    stateFingerprint: alias.stateFingerprint ?? null,
    source: alias.source ?? 'indexed',
    hits: alias.hits ?? 0,
    createdAt: '2026-07-27T00:00:00.000Z',
  }));

  return {
    idByKey,
    snapshot: {
      tenantId: TENANT_ID,
      applicationId: APPLICATION_ID,
      memoryVersion,
      screens: screenNodes,
      elements,
      navEdges: [],
      aliases: aliasRows,
      generatedAt: '2026-07-27T00:00:00.000Z',
    },
  };
}

/**
 * A deterministic embedder for the T1 and resolver suites.
 *
 * It maps each text to a vector through a table, defaulting to a per-text hashed vector for
 * anything unlisted, and normalises like the real one — so ranking is exact and repeatable
 * without an inference session. `calls` counts `embed` invocations, which is how the caching
 * tests prove a screen is embedded once rather than per utterance.
 */
export interface FakeEmbedder extends Embedder {
  calls: number;
  embeddedTexts: string[][];
}

export function fakeEmbedder(table: Record<string, number[]>, dims = 8): FakeEmbedder {
  const state = { calls: 0, embeddedTexts: [] as string[][] };

  function vectorFor(text: string): Float32Array {
    const listed = table[text];
    if (listed !== undefined) return normalize(Float32Array.from(padTo(listed, dims)));
    // A stable pseudo-vector for unlisted text, so an unmapped candidate still gets a low but
    // deterministic similarity rather than a throw.
    const vector = new Float32Array(dims);
    for (let i = 0; i < text.length; i += 1) {
      const idx = i % dims;
      vector[idx] = (vector[idx] ?? 0) + ((text.charCodeAt(i) % 13) - 6) / 10;
    }
    return normalize(vector);
  }

  return {
    dims,
    get calls(): number {
      return state.calls;
    },
    set calls(value: number) {
      state.calls = value;
    },
    get embeddedTexts(): string[][] {
      return state.embeddedTexts;
    },
    embed(texts: readonly string[]): Promise<Float32Array[]> {
      state.calls += 1;
      state.embeddedTexts.push([...texts]);
      return Promise.resolve(texts.map(vectorFor));
    },
    dispose(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function padTo(values: readonly number[], dims: number): number[] {
  const out = Array<number>(dims).fill(0);
  for (let i = 0; i < Math.min(values.length, dims); i += 1) out[i] = values[i] ?? 0;
  return out;
}
