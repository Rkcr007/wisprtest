import { describe, expect, it } from 'vitest';

import { buildManifest } from './manifest.js';

/**
 * The permission set is a claim about what this extension can do, and it is reviewed — by
 * Phase 19's security pass, by an enterprise admin before force-installing it, and by the Chrome
 * Web Store. Each assertion here is a permission we would have to justify aloud if it changed.
 */

const manifest = buildManifest({ version: '1.2.3', gatewayOrigin: 'https://gateway.example' });

describe('permissions', () => {
  it('asks for storage and alarms, and nothing else', () => {
    // Adding to this list should require changing this test, and changing this test should
    // require an answer to "what breaks without it?".
    expect(manifest.permissions).toEqual(['storage', 'alarms']);
  });

  it('can reach the control plane and nothing else', () => {
    // The applications under test are operated in-process through the DOM, never over the
    // network — CLAUDE.md rule #2. So the only host the extension needs to fetch is the gateway.
    expect(manifest.host_permissions).toEqual(['https://gateway.example/*']);
  });

  it('derives the gateway host permission from the origin it was built for', () => {
    const local = buildManifest({ version: '0.0.0', gatewayOrigin: 'http://127.0.0.1:8080' });

    // The fetch and the permission come from one build parameter. Two sources would drift, and
    // the symptom would be a request blocked at runtime in a customer's tab.
    expect(local.host_permissions).toEqual(['http://127.0.0.1:8080/*']);
  });

  it('exposes no web-accessible resources', () => {
    // Any exposed resource lets an arbitrary page detect that this extension is installed. A QA
    // tool has no reason to add a fingerprinting surface.
    expect(manifest).not.toHaveProperty('web_accessible_resources');
  });

  it('does not ask for tabs, scripting or downloads', () => {
    const permissions = manifest.permissions as string[];

    for (const unwanted of ['tabs', 'scripting', 'downloads', 'webRequest', 'cookies']) {
      expect(permissions, unwanted).not.toContain(unwanted);
    }
  });
});

describe('content script', () => {
  it('runs in the top frame only, after the application has booted', () => {
    const [script] = manifest.content_scripts as {
      matches: string[];
      all_frames: boolean;
      run_at: string;
    }[];

    // One HUD per tab: `all_frames` would render a panel per iframe on a framed application.
    expect(script?.all_frames).toBe(false);
    // After the application's own scripts, so mounting cannot race its bootstrap.
    expect(script?.run_at).toBe('document_idle');
    expect(script?.matches).toEqual(['<all_urls>']);
  });
});

describe('the rest of the manifest', () => {
  it('is manifest v3 with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
  });

  it('carries the version it was built with', () => {
    expect(manifest.version).toBe('1.2.3');
  });

  it('requires a Chrome new enough to keep the token from content scripts', () => {
    // `chrome.storage.session.setAccessLevel` lands in 116. Below that the token could be read
    // by a content script, which is the one thing the storage design exists to prevent.
    expect(manifest.minimum_chrome_version).toBe('116');
  });
});
