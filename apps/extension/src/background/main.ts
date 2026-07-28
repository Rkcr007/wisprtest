import { consoleSink, createLogger } from '../log.js';
import { HUD_PORT } from '../messaging.js';
import type { OffscreenCommand } from '../voice/messages.js';
import { createAttachController } from './attach.js';
import { createMemoryClient } from './memory-client.js';
import { createTokenClient } from './token-client.js';
import { createTokenStore } from './token-store.js';
import { createVoiceController, type OffscreenManager } from './voice-controller.js';

/**
 * MV3 service worker entrypoint.
 *
 * A service worker has no SIGTERM analogue: Chrome terminates it after roughly thirty seconds
 * idle and restarts it on the next event. "Shutting down cleanly" therefore means holding no
 * state that cannot be rebuilt from an event — which is why the token lives in session storage
 * and the refresh is an alarm rather than a timer.
 *
 * Everything here is wiring. The behaviour lives in `attach.ts`, `token-client.ts` and
 * `token-store.ts`, all of which take their dependencies as arguments so they can be tested
 * without a browser.
 */

/** Build-time constants, substituted by `src/build.ts`. */
declare const __WISPR_GATEWAY_ORIGIN__: string;
declare const __WISPR_ENV__: string;
declare const __WISPR_ASR_TOKEN__: string;

const logger = createLogger({ service: 'extension', env: __WISPR_ENV__ }, consoleSink);

/**
 * The offscreen document that hosts the microphone, behind the interface the voice controller
 * drives. `getUserMedia` is unavailable in this worker, so capture lives in that document; it is
 * created on the first push-to-talk and closed when the tester stops, so the microphone indicator
 * does not linger.
 */
const offscreen: OffscreenManager = {
  async ensure(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) return;
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'Capture the microphone for voice-driven QA commands.',
      });
    } catch (error: unknown) {
      // A concurrent `ensure` may have created it between the check and here; that is not a failure.
      if (!(await chrome.offscreen.hasDocument())) throw error;
    }
  },
  async close(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  },
  async send(command: OffscreenCommand): Promise<void> {
    await chrome.runtime.sendMessage(command);
  },
};

const voice = createVoiceController({
  offscreen,
  // Dev-only: the token is baked in for local testing and empty otherwise. Production mints a
  // short-lived one from the gateway (a later phase); until then this truthfully reports no token.
  mintToken: () => Promise.resolve(__WISPR_ASR_TOKEN__ === '' ? null : __WISPR_ASR_TOKEN__),
  onMetric: (name, valueMs) => {
    logger.log('info', 'voice.metric', { metric: name, value_ms: valueMs, unit: 'ms' }, 'voice metric');
  },
  onError: (event, error) => {
    logger.log('warn', event, { detail: describe(error) }, 'voice controller recovered');
  },
});

const controller = createAttachController({
  tokens: createTokenClient({ gatewayOrigin: __WISPR_GATEWAY_ORIGIN__ }),
  store: createTokenStore(chrome.storage.session),
  memory: createMemoryClient({ gatewayOrigin: __WISPR_GATEWAY_ORIGIN__ }),
  voice,
  alarms: {
    create: (name, info) => {
      // `chrome.alarms.create` resolves once the alarm is registered; nothing here waits on it,
      // and a failure to register surfaces as a refresh that never fires rather than a rejection
      // to handle.
      void chrome.alarms.create(name, info);
    },
    clear: (name) => chrome.alarms.clear(name),
  },
  onError: (event, error) => {
    // The error is reduced to a string here rather than logged as an object: an error from a
    // failed fetch can carry a request body, and a request body can carry a token.
    logger.log('warn', event, { detail: describe(error) }, 'extension worker recovered');
  },
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== HUD_PORT) return;
  controller.connect(port);
});

// Events from the offscreen voice document arrive as one-off runtime messages (a content script
// uses the HUD port instead, so this only hears the offscreen document). The controller ignores
// anything that is not a voice event.
chrome.runtime.onMessage.addListener((message: unknown) => {
  voice.handleEvent(message);
});

// The toolbar button toggles the panel on the current tab. It is the tester's way to get the HUD
// off the screen entirely without disabling the extension.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void controller.toggle(tab.id);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void controller.onAlarm(alarm.name);
});

function logStarted(trigger: string): void {
  logger.log(
    'info',
    'service.started',
    { trigger, extension_version: chrome.runtime.getManifest().version },
    'extension service worker started',
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  logStarted(`install:${details.reason}`);
});

chrome.runtime.onStartup.addListener(() => {
  logStarted('browser_startup');
});

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'unknown error';
}
