/**
 * The MV3 manifest, as data.
 *
 * Generated into `dist/manifest.json` by `src/build.ts`, so that every permission can carry the
 * justification for *why the extension needs it* next to the line that requests it. A permission
 * list nobody can explain is one that only ever grows, and Phase 19's security pass reviews this
 * file against what the code actually does.
 *
 * The gateway origin is a build parameter rather than a constant: `host_permissions` must be
 * static in a manifest, and a deployment's gateway is not knowable when this file is written.
 */

export interface ManifestOptions {
  readonly version: string;
  /** Origin of the control plane, e.g. `https://gateway.wisprtest.dev`. */
  readonly gatewayOrigin: string;
}

export function buildManifest(options: ManifestOptions): Record<string, unknown> {
  const gateway = new URL(options.gatewayOrigin);

  return {
    manifest_version: 3,
    name: 'WisprTest',
    version: options.version,
    description: 'Voice-native execution layer for manual QA of enterprise web applications.',

    // Chrome 116 is the floor for `chrome.storage.session.setAccessLevel`, which is what keeps
    // the scoped token out of content scripts. Anything older cannot hold that guarantee.
    minimum_chrome_version: '116',

    permissions: [
      /**
       * `storage` — the scoped gateway token lives in `chrome.storage.session`, which is
       * memory-backed and cleared when the browser closes. Without it the token would have to be
       * refetched every time Chrome terminates the idle service worker, which is roughly every
       * 30 seconds of quiet: a token request per pause in a tester's session.
       *
       * Session storage specifically, never `local`: `local` is on disk, and a bearer token for a
       * customer's tenant does not belong on disk.
       */
      'storage',

      /**
       * `alarms` — token refresh has to survive the service worker being terminated, and a
       * `setTimeout` does not. An alarm wakes the worker shortly before the token expires, so the
       * first command after a quiet period does not pay for a token round trip — or fail on an
       * expired one.
       */
      'alarms',
    ],

    /**
     * The control plane, and nothing else. This is the only origin the extension may `fetch`.
     *
     * Note what is *not* here: the applications under test. The extension never makes network
     * requests to them — it operates their DOM in-process, which is the whole point of the hot
     * path being in the content script (CLAUDE.md rule #2).
     */
    host_permissions: [`${gateway.origin}/*`],

    background: {
      service_worker: 'background.js',
      type: 'module',
    },

    /**
     * Declared rather than injected on click, and matched broadly. Both parts need justifying,
     * because between them they are the most invasive thing this extension asks for.
     *
     * **Why `<all_urls>`:** a tester names the application they are working on. It is a
     * customer's internal system on a hostname WisprTest cannot know at build time, and it
     * differs per tenant, per environment and per tester.
     *
     * **Why not `activeTab`:** `activeTab` is the smaller permission and it does not work here.
     * The grant it gives is revoked on navigation, so the HUD would disappear the moment the
     * tester followed a link inside the application they are testing — which is the second thing
     * anyone does. A QA overlay that survives the application's own navigation has to be a
     * declared content script.
     *
     * **What limits it in practice:** the script mounts a collapsed, inert panel and does nothing
     * else until the tester attaches. It reads no page content, sends no page content anywhere,
     * and holds no credentials — see `content/mount.ts` and `background/token-store.ts`.
     */
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['content.js'],
        // After the application's own scripts have run, so mounting cannot race its bootstrap.
        run_at: 'document_idle',
        // Top frame only. A HUD per iframe would render several panels on a framed application.
        all_frames: false,
      },
    ],

    /**
     * The toolbar button. Toggles the HUD's visibility on the current tab — the tester's way to
     * get it off the screen entirely without disabling the extension.
     */
    action: {
      default_title: 'Show or hide the WisprTest panel',
    },

    /**
     * No `web_accessible_resources`.
     *
     * Everything the HUD needs is bundled into the content script and rendered into a shadow
     * root. Exposing a resource would let any page on the internet detect that this extension is
     * installed, which is a fingerprinting surface a QA tool has no need to add.
     */
  };
}
