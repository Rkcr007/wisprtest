import { describe, expect, it } from 'vitest';

import {
  captureRegion,
  containingLandmark,
  contentHash,
  serializeRedacted,
  shouldCapture,
} from './evidence.js';

/**
 * Evidence capture.
 *
 * The assertion that carries this suite is the PII one. A DOM snapshot of a real application is
 * exactly what CLAUDE.md § "PII rule" exists to keep in the browser — a table of customer names, an
 * email in a field, an invoice total. The serialiser therefore never emits raw text at all: it
 * captures structure, and every piece of content goes through the redactor on the way out.
 */

function fixture(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild as Element;
}

describe('what gets captured, and when', () => {
  it('captures on a check, because the evidence is the result', () => {
    expect(shouldCapture({ verb: 'check', outcome: 'executed' })).toBe(true);
  });

  it('captures on a failure, because that is what a tester will be asked to explain', () => {
    expect(shouldCapture({ verb: 'click', outcome: 'failed' })).toBe(true);
    expect(shouldCapture({ verb: 'click', outcome: 'rejected' })).toBe(true);
  });

  it('captures nothing on an ordinary successful action', () => {
    // A screenshot per click costs storage, bandwidth and a great deal of a customer's screen for
    // a question nobody asks.
    expect(shouldCapture({ verb: 'click', outcome: 'executed' })).toBe(false);
    expect(shouldCapture({ verb: 'navigate', outcome: 'executed' })).toBe(false);
  });
});

describe('the snapshot never carries content', () => {
  it('redacts text nodes', () => {
    const root = fixture(`
      <section aria-label="Orders">
        <p>Contact jane.doe@acme.com about invoice 4471</p>
      </section>
    `);

    const html = serializeRedacted(root);

    expect(html).not.toContain('jane.doe@acme.com');
    expect(html).toContain('[email]');
    // The structure is what remains, and it is what the snapshot is for.
    expect(html).toContain('<section aria-label="Orders">');
  });

  it('redacts attribute values that carry content', () => {
    const root = fixture(`
      <form>
        <input name="email" placeholder="jane.doe@acme.com" value="j.doe@acme.com" />
        <a href="/orders/4471?customer=jane.doe@acme.com" title="Acme order 4471">View</a>
      </form>
    `);

    const html = serializeRedacted(root);

    expect(html).not.toContain('jane.doe@acme.com');
    expect(html).not.toContain('j.doe@acme.com');
    // `name` is structure and survives; the values beside it do not.
    expect(html).toContain('name="email"');
  });

  it('keeps no attribute that was not asked for', () => {
    const root = fixture(`
      <div data-customer-name="Jane Doe" data-balance="46200.55" role="region">x</div>
    `);

    const html = serializeRedacted(root);

    // An allowlist, not a blocklist: an application's own data attributes are content by default,
    // and a blocklist would leak every one nobody thought of.
    expect(html).not.toContain('Jane Doe');
    expect(html).not.toContain('46200.55');
    expect(html).toContain('role="region"');
  });

  it('drops scripts and styles entirely', () => {
    const root = fixture(`
      <main>
        <script>window.customer = 'Jane Doe';</script>
        <style>.x { color: red }</style>
        <button>Approve</button>
      </main>
    `);

    const html = serializeRedacted(root);

    expect(html).not.toContain('Jane Doe');
    expect(html).not.toContain('<script');
    expect(html).toContain('<button>Approve</button>');
  });

  it('bounds a large subtree, and says that it did', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `<li>row ${String(i)}</li>`).join('');
    const root = fixture(`<ul>${rows}</ul>`);

    const html = serializeRedacted(root, { maxChildren: 5 });

    expect(html).toContain('195 more children omitted');
    // Said out loud rather than silently cut, so nobody reads a truncated table as a short one.
    expect(html.match(/<li>/g) ?? []).toHaveLength(5);
  });

  it('bounds depth', () => {
    const deep = '<div>'.repeat(30) + 'x' + '</div>'.repeat(30);
    const root = fixture(deep);

    const html = serializeRedacted(root, { maxDepth: 3 });

    expect(html).toContain('data-wispr-truncated="depth"');
  });

  it('escapes what it emits, so a snapshot cannot smuggle markup', () => {
    const root = fixture(`<div title='a"b'>&lt;img onerror=x&gt;</div>`);

    const html = serializeRedacted(root);

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('the region a snapshot and a screenshot cover', () => {
  it('takes the containing landmark, not the whole document', () => {
    fixture(`
      <main>
        <nav><a href="/x">elsewhere</a></nav>
        <section aria-label="Orders"><button id="approve">Approve</button></section>
      </main>
    `);
    const button = document.querySelector('#approve') as Element;

    const landmark = containingLandmark(button);

    // The unit a tester would point at: "the orders section", not the element alone and not the
    // entire application.
    expect(landmark.getAttribute('aria-label')).toBe('Orders');
  });

  it('falls back to the body when nothing landmark-like contains the element', () => {
    fixture(`<div><button id="loose">Approve</button></div>`);
    const button = document.querySelector('#loose') as Element;

    expect(containingLandmark(button)).toBe(document.body);
  });

  it('pads the screenshot region and clamps it to the viewport', () => {
    const element = {
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 40 }),
    } as unknown as Element;

    const region = captureRegion(element, { width: 200, height: 100 }, 24);

    // Padded, because a control photographed edge to edge shows nothing about *why* it failed —
    // the error message beside it usually is the answer.
    expect(region.x).toBe(0);
    expect(region.y).toBe(0);
    // Clamped, so the capture never asks for pixels that do not exist.
    expect(region.x + region.width).toBeLessThanOrEqual(200);
    expect(region.y + region.height).toBeLessThanOrEqual(100);
  });
});

describe('content hashing', () => {
  it('hashes bytes so stored evidence can be verified later', async () => {
    const bytes = new TextEncoder().encode('fake-png');

    const hash = await contentHash(bytes);

    // SHA-256, hex — the same hash the gateway stores beside the reference, and the reason a
    // screenshot can be shown to have not been altered since capture.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await contentHash(bytes)).toBe(hash);
    expect(await contentHash(new TextEncoder().encode('other'))).not.toBe(hash);
  });
});
