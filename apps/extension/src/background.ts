import { consoleSink, createLogger } from './log.js';

/**
 * MV3 service worker entrypoint.
 *
 * A service worker has no SIGTERM analogue: Chrome terminates it after ~30s idle and restarts
 * it on the next event, so "shut down cleanly" means holding no state that cannot be rebuilt
 * from an event. Phase 6 adds the scoped-token lifecycle and the content-script message
 * channel; Phase 12 makes the session buffer survive exactly this termination.
 */

/**
 * An unpacked (developer-loaded) extension has no `update_url`; one installed from the Web
 * Store or an enterprise policy does. That is the only environment signal available to a
 * service worker without shipping a build-time define, which arrives with the bundler in Phase 6.
 */
const env = chrome.runtime.getManifest().update_url === undefined ? 'development' : 'production';

const logger = createLogger({ service: 'extension', env }, consoleSink);

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
