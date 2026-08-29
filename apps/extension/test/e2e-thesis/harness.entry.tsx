import { computeStateFingerprint, interactiveCandidates, toRoutePattern } from 'fingerprint';
import type { MemorySnapshot } from 'protocol';

import {
  createActionExecutor,
  createRelayDispatcher,
  type CdpCommand,
} from '../../src/executor/index.js';
import { normalize, type Embedder } from '../../src/resolver/embedder.js';
import { createResolver } from '../../src/resolver/index.js';
import { createSeedIntentDetector } from '../../src/seed/index.js';
import {
  buildIntentVocabulary,
  createBinderLocator,
  createIntentParser,
  createSpeculationController,
  IDLE_VIEW,
  type SpeculationView,
} from '../../src/speculation/index.js';

/**
 * The shipping runtime, in the page, against the live fixture app.
 *
 * Speech stands in as a finished transcript — the same way every suite downstream of Phase 9
 * does — because a headless Chromium has no microphone and the thesis is Remember → Execute,
 * not the ASR provider. Typed commands and `wisprCommand` both enter through `onFinal`.
 */

declare const __WISPR_THESIS_SNAPSHOT__: MemorySnapshot;

declare global {
  interface Window {
    wisprCommand(transcript: string): Promise<void>;
    wisprConfirm(): void;
    wisprView(): SpeculationView;
    wisprWasSeed(): boolean;
    wisprDebug(): {
      readonly route: string;
      readonly routePattern: string;
      readonly stateFingerprint: string;
      readonly screenFingerprints: readonly string[];
      readonly candidateCount: number;
      readonly view: SpeculationView;
    };
    wisprCdp?(command: CdpCommand): Promise<void>;
  }
}

const SNAPSHOT = __WISPR_THESIS_SNAPSHOT__;
const DIMS = 64;

function fail(error: unknown): void {
  document.documentElement.dataset.wisprThesisError =
    error instanceof Error ? `${error.name}: ${error.message}` : 'harness failed';
}

/**
 * A bag-of-words embedder so T1 can rank paraphrases without shipping ONNX into this harness.
 *
 * The real bge-small model is what `test:resolver` already runs against these same pages. This
 * stand-in only has to put "pending ones" nearer "Show pending only" than the delete buttons.
 */
function lexicalEmbedder(): Embedder {
  function vectorFor(text: string): Float32Array {
    const vector = new Float32Array(DIMS);
    const stop = new Set(['the', 'a', 'an', 'me', 'i', 'to', 'of', 'and', 'for']);
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word === '' || stop.has(word)) continue;
      let hash = 2166136261;
      for (let i = 0; i < word.length; i += 1) {
        hash ^= word.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const index = (hash >>> 0) % DIMS;
      vector[index] = (vector[index] ?? 0) + 1;
    }
    return normalize(vector);
  }

  return {
    dims: DIMS,
    embed(texts: readonly string[]): Promise<Float32Array[]> {
      return Promise.resolve(texts.map(vectorFor));
    },
    dispose(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function currentScope(): {
  readonly stateFingerprint: string;
  readonly candidates: readonly Element[];
} {
  const routePattern = toRoutePattern(window.location.href);
  return {
    stateFingerprint: computeStateFingerprint(routePattern, [], ''),
    candidates: [...interactiveCandidates(document.body)],
  };
}

try {
  boot();
} catch (error: unknown) {
  fail(error);
}

function boot(): void {
  const source = { current: currentScope };
  const resolver = createResolver({
    snapshot: SNAPSHOT,
    embedder: lexicalEmbedder(),
    source,
  });
  const locator = createBinderLocator(SNAPSHOT);
  const executor = createActionExecutor({
    window,
    dispatcher: createRelayDispatcher(async (command) => {
      if (window.wisprCdp === undefined) throw new Error('CDP relay is not installed');
      await window.wisprCdp(command);
    }),
  });
  const detector = createSeedIntentDetector();
  const controller = createSpeculationController({
    parser: createIntentParser({ vocabulary: buildIntentVocabulary(SNAPSHOT) }),
    resolver,
    executor,
    locator,
    source,
    sessionId: '33333333-3333-4333-8333-333333333333',
  });

  let view: SpeculationView = IDLE_VIEW;
  let wasSeed = false;
  let revision = 0;

  controller.view.subscribe((next) => {
    view = next;
  });

  async function run(transcript: string): Promise<void> {
    revision += 1;
    wasSeed = detector.detect(transcript).isSeed;
    controller.onSpeechOnset();
    if (!wasSeed) await controller.onFinal({ revision, transcript });
  }

  window.wisprCommand = run;
  window.wisprConfirm = () => {
    controller.confirm();
  };
  window.wisprView = () => view;
  window.wisprWasSeed = () => wasSeed;

  window.wisprDebug = () => {
    const scope = currentScope();
    return {
      route: window.location.pathname,
      routePattern: toRoutePattern(window.location.href),
      stateFingerprint: scope.stateFingerprint,
      screenFingerprints: SNAPSHOT.screens.map((screen) => screen.stateFingerprint),
      candidateCount: scope.candidates.length,
      view,
    };
  };

  document.documentElement.dataset.wisprThesisReady = 'true';
}
