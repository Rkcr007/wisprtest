import { describe, expect, it } from 'vitest';

import { createActionExecutor } from '../../src/executor/index.js';
import { createIntentParser } from '../../src/speculation/index.js';
import {
  createSpeculationController,
  type Locator,
  type ResolverLike,
} from '../../src/speculation/index.js';
import { SCRIPTED_UTTERANCE } from '../../src/voice/testing.js';

/**
 * The speech-to-reticle latency gate.
 *
 * CLAUDE.md § "Performance budgets": speech onset → reticle rendered, p95 < 400 ms. This drives the
 * speculation controller through the *scripted ASR fixture from Phase 9* — the same partial → revision
 * → final sequence the voice pipeline replays — and measures, per utterance, the wall-clock time from
 * `onSpeechOnset()` to the first non-idle {@link SpeculationView} the HUD would render a reticle from.
 *
 * What it measures is the on-page path: parse → scoped resolve → classify → stage/aim → publish. It
 * does not include ASR network time (that is the voice pipeline's own `wispr_speech_to_partial_ms`
 * gate) and it uses a T0-speed resolver, because the reticle is drawn the instant the first partial
 * resolves and that is the latency a tester feels. A regression in the controller's hot path fails
 * the build here rather than in production.
 */

const ITERATIONS = 80;
const BUDGET_MS = 400;

/** A T0-speed resolver: every named phrase resolves to the one on-screen target, instantly. */
function fastResolver(elementKey: string, elementId: string): ResolverLike {
  return {
    resolve: (_phrase) =>
      Promise.resolve({
        outcome: 'resolved',
        elementId,
        elementKey,
        confidence: 0.98,
        tier: 'T0',
        latencyMs: 2,
        candidates: [],
      }),
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

describe('speech onset → reticle rendered', () => {
  it(`stays under ${String(BUDGET_MS)} ms at p95 across the scripted utterance`, async () => {
    const target = document.createElement('button');
    target.textContent = 'Pending';
    document.body.append(target);

    const KEY = 'orders.filter.pending';
    const ID = '00000000-0000-4000-8000-0000000000aa';
    const locator: Locator = { locate: () => target };

    const controller = createSpeculationController({
      parser: createIntentParser({
        vocabulary: { navTargets: new Set(['orders']), landmarks: new Set() },
      }),
      resolver: fastResolver(KEY, ID),
      executor: createActionExecutor({
        dispatcher: { mouse: () => Promise.resolve(), key: () => Promise.resolve() },
        window,
        sleep: () => Promise.resolve(),
      }),
      locator,
      source: { current: () => ({ stateFingerprint: 'a'.repeat(64), candidates: [target] }) },
      window,
    });

    const latencies: number[] = [];

    for (let i = 0; i < ITERATIONS; i += 1) {
      // A fresh utterance: onset resets to idle, so the reticle we time is this iteration's.
      controller.onSpeechOnset();

      const onset = performance.now();
      let reticleAt = 0;
      let revision = 1;
      for (const transcript of SCRIPTED_UTTERANCE.partials) {
        await controller.onPartial({ revision: revision++, transcript });
        // The controller publishes its view synchronously inside `process`, before the await
        // settles — so the first non-idle phase after a partial is the reticle being rendered.
        if (reticleAt === 0 && controller.view.value.phase !== 'idle')
          reticleAt = performance.now();
      }

      if (reticleAt === 0) throw new Error('the reticle never rendered for the scripted utterance');
      latencies.push(reticleAt - onset);
    }

    const p95 = percentile(latencies, 0.95);
    // Reported so a passing-but-creeping number is visible in CI output, not just a green tick.
    console.log(`speech-to-reticle p95=${p95.toFixed(2)}ms over ${String(ITERATIONS)} iterations`);
    expect(p95).toBeLessThan(BUDGET_MS);

    controller.dispose();
    target.remove();
  });
});
