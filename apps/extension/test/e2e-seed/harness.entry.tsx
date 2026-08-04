import { createRoot } from 'react-dom/client';
import { uiCss } from 'ui';
import type { RuntimeState } from 'protocol';

import { createSeedClient } from '../../src/background/seed-client.js';
import { hudCss } from '../../src/content/hud.css.js';
import { SeedMarks } from '../../src/content/SeedMarks.js';
import { SeedPreview } from '../../src/content/SeedPreview.js';
import {
  createSeedController,
  createSeedIntentDetector,
  IDLE_SEED_VIEW,
  type SeedController,
  type SeedView,
} from '../../src/seed/index.js';

/**
 * The extension's seeding half, running in a real browser against a real application.
 *
 * Everything imported here is the shipping code: the intent detector that decides an utterance is a
 * request for data, the controller that enforces class S, the client that talks to the gateway, and
 * the two components a tester actually reads and clicks. Nothing is reimplemented for the test.
 *
 * ## What stands in, and what does not
 *
 * The service worker does. In the product the content script posts over a port and the worker adds
 * the session id, the application id and the token; here the client is called directly with those
 * three supplied. That boundary is covered by `seed-client.test.ts` and by the attach controller's
 * own suite — what this file exists to prove is the part neither of those can reach: that the loop
 * works end to end in a browser, against an application whose records really appear and disappear.
 *
 * Speech stands in too, as it does in every suite downstream of Phase 9: `speak()` delivers a final
 * transcript the way the voice pipeline would. It is deliberately the *only* way in, because the
 * property under test is that seeding is reachable from a final transcript and from nothing else.
 */

declare global {
  interface Window {
    /** Deliver a final transcript, as the voice pipeline would. */
    wisprSpeak(transcript: string): Promise<void>;
    /** The controller's current view, for assertions that are about state rather than pixels. */
    wisprSeedView(): SeedView;
    /** Whether the last utterance was routed to seeding. */
    wisprWasSeed(): boolean;
  }
}

/**
 * Substituted at bundle time, the way the extension's own build supplies its gateway origin.
 *
 * Not read from the document: the harness script runs before anything could have written an
 * attribute for it, which is the same reason the real build bakes `__WISPR_GATEWAY_ORIGIN__` in.
 */
declare const __WISPR_SEED_GATEWAY__: string;
const GATEWAY_ORIGIN = __WISPR_SEED_GATEWAY__;

const RUNTIME_STATE: RuntimeState = {
  route: '/orders',
  routePattern: '/orders',
  modalStack: [],
  focusedLandmark: null,
  visibleElementKeys: ['orders.list.row'],
  structuralHash: 'a'.repeat(64),
  stateFingerprint: 'b'.repeat(64),
  capturedAt: new Date().toISOString(),
};

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const APPLICATION_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'e2e.scoped.token';

const client = createSeedClient({ gatewayOrigin: GATEWAY_ORIGIN });
const detector = createSeedIntentDetector();

const controller: SeedController = createSeedController({
  transport: {
    plan: async ({ utterance, runtimeState }) => {
      const outcome = await client.plan({
        sessionId: SESSION_ID,
        applicationId: APPLICATION_ID,
        utterance,
        runtimeState,
        bearerToken: TOKEN,
      });
      return outcome.ok
        ? { ok: true, response: outcome.value }
        : { ok: false, reason: outcome.reason, detail: outcome.detail };
    },
    execute: async ({ planId, approvedAt }) => {
      const outcome = await client.execute({
        sessionId: SESSION_ID,
        planId,
        approvedAt,
        bearerToken: TOKEN,
      });
      return outcome.ok
        ? { ok: true, result: outcome.value.result, ledger: outcome.value.ledger }
        : { ok: false, reason: outcome.reason, detail: outcome.detail };
    },
    revert: async (input) => {
      const outcome = await client.revert({
        scope:
          input.scope === 'entry'
            ? { kind: 'entry', ledgerEntryId: input.ledgerEntryId }
            : { kind: 'session', sessionId: SESSION_ID },
        bearerToken: TOKEN,
      });
      return outcome.ok
        ? { ok: true, outcomes: outcome.value.outcomes }
        : { ok: false, reason: outcome.reason, detail: outcome.detail };
    },
  },
});

let view: SeedView = IDLE_SEED_VIEW;
let wasSeed = false;

// Mounted in a shadow root, exactly as the HUD is: the assertion that the application's own DOM is
// untouched only means something if the marks and the card are rendered the way they really are.
const host = document.createElement('wispr-test-seed');
host.setAttribute(
  'style',
  'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483000 !important;',
);
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = `${uiCss}\n${hudCss}`;
shadow.append(style);
const container = document.createElement('div');
container.className = 'wispr-hud-root';
shadow.append(container);
document.documentElement.append(host);

const root = createRoot(container);

function paint(): void {
  root.render(
    <>
      <SeedMarks
        externalRefs={view.ledger.map((entry) => entry.externalRef)}
        stateFingerprint={RUNTIME_STATE.stateFingerprint}
      />
      <div className="wispr-hud" style={{ width: '340px' }}>
        <SeedPreview
          view={view}
          onApprove={() => {
            void controller.approve();
          }}
          onDismiss={() => {
            controller.dismiss();
          }}
          onRevertSession={() => {
            void controller.revertSession();
          }}
        />
      </div>
    </>,
  );
}

controller.view.subscribe((next) => {
  view = next;
  paint();
});

window.wisprSeedView = () => view;
window.wisprWasSeed = () => wasSeed;

window.wisprSpeak = async (transcript: string): Promise<void> => {
  // The fork, as `content/main.tsx` performs it on a final transcript.
  wasSeed = detector.detect(transcript).isSeed;
  if (wasSeed) await controller.plan(transcript, RUNTIME_STATE);
};

paint();
document.documentElement.dataset.wisprSeedReady = 'true';
