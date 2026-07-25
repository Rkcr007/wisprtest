import { describe, expect, it } from 'vitest';

import {
  extractStableAttributes,
  extractStructuralAttributes,
  isGeneratedValue,
} from './attributes.js';
import { DEFAULT_CONFIG, resolveConfig, resolveContext, viewportFor } from './config.js';
import { computeFingerprint, computeOrdinal } from './fingerprint.js';
import { bboxSimilarity, normalizeRect } from './geometry.js';
import { computeLandmarkPath, landmarkPathSimilarity } from './landmarks.js';
import { computeRole } from './role.js';
import { defaultRedactor } from './redact.js';
import { laidOut, one, render } from './testing.js';
import { computeTextShingleHash, shingles } from './text.js';

describe('computeRole', () => {
  it.each([
    ['<button>x</button>', 'button', 'button'],
    ['<a href="/x">x</a>', 'a', 'link'],
    ['<a>x</a>', 'a', 'generic'],
    ['<input />', 'input', 'textbox'],
    ['<input type="checkbox" />', 'input', 'checkbox'],
    ['<input type="search" />', 'input', 'searchbox'],
    ['<input type="number" />', 'input', 'spinbutton'],
    ['<input type="submit" />', 'input', 'button'],
    ['<input type="hidden" />', 'input', 'generic'],
    ['<select><option>a</option></select>', 'select', 'combobox'],
    ['<textarea></textarea>', 'textarea', 'textbox'],
    ['<nav></nav>', 'nav', 'navigation'],
    ['<main></main>', 'main', 'main'],
    ['<h2>x</h2>', 'h2', 'heading'],
    ['<ul></ul>', 'ul', 'list'],
    ['<div></div>', 'div', 'generic'],
  ])('maps %s to %s → %s', (html, selector, expected) => {
    expect(computeRole(one(render(html), selector))).toBe(expected);
  });

  it('lets an explicit role win over the implicit one', () => {
    expect(computeRole(one(render('<div role="button">x</div>'), 'div'))).toBe('button');
    expect(computeRole(one(render('<button role="link">x</button>'), 'button'))).toBe('link');
  });

  it('takes the first token of a role fallback list', () => {
    expect(computeRole(one(render('<div role="switch checkbox">x</div>'), 'div'))).toBe('switch');
  });

  it('ignores an empty role attribute', () => {
    expect(computeRole(one(render('<button role="  ">x</button>'), 'button'))).toBe('button');
  });

  it('treats a text input with a datalist as a combobox', () => {
    // Meaningfully different: the two are operated in completely different ways.
    const root = render('<input list="opts" /><datalist id="opts"></datalist>');
    expect(computeRole(one(root, 'input'))).toBe('combobox');
  });

  it('makes <section> a region only when it is named', () => {
    expect(computeRole(one(render('<section></section>'), 'section'))).toBe('generic');
    expect(computeRole(one(render('<section aria-label="Orders"></section>'), 'section'))).toBe(
      'region',
    );
  });

  it('makes <header> a banner only outside sectioning content', () => {
    expect(computeRole(one(render('<header></header>'), 'header'))).toBe('banner');
    expect(computeRole(one(render('<article><header></header></article>'), 'header'))).toBe(
      'generic',
    );
  });
});

describe('isGeneratedValue', () => {
  it.each([
    [':r1:', 'React useId'],
    [':R2ab:', 'React useId, uppercase form'],
    ['radix-:r7:', 'Radix, derived from useId'],
    ['ember123', 'Ember auto-id'],
    ['cdk-overlay-0', 'Angular CDK'],
    ['mat-input-5', 'Angular Material'],
    ['ng-tns-c12-3', 'Angular view encapsulation'],
    ['css-1x2y3z', 'Emotion'],
    ['sc-bdVaJa', 'styled-components'],
    ['jss42', 'JSS'],
    ['mui-1234', 'MUI'],
    ['Button_root__1a2b3', 'CSS module hashed suffix'],
    ['a3f9c1e8', 'a hex blob'],
    ['V1StGXR8Z5jdHi6BmyT', 'a nanoid'],
    ['row-3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'a UUID embedded in an id'],
    ['list-item-1841', 'a long trailing counter'],
    ['row_20260725', 'a date stamp suffix'],
    ['', 'an empty value'],
  ])('rejects %j — %s', (value) => {
    expect(isGeneratedValue(value, DEFAULT_CONFIG)).toBe(true);
  });

  it.each([
    ['approve-order', 'a hand-written kebab id'],
    ['account_name', 'a hand-written snake id'],
    ['submit', 'a single word'],
    ['step-2', 'a short counter a human plausibly wrote'],
    ['tab-3', 'another short counter'],
    ['orders.filter.pending', 'an element key'],
  ])('accepts %j — %s', (value) => {
    expect(isGeneratedValue(value, DEFAULT_CONFIG)).toBe(false);
  });

  it('is overridable, because the right balance is per application', () => {
    const strict = resolveConfig({ generatedValuePatterns: [/^step-/] });
    expect(isGeneratedValue('step-2', strict)).toBe(true);
    expect(isGeneratedValue(':r1:', strict)).toBe(false);
  });
});

describe('extractStableAttributes', () => {
  it('collects hand-written identity attributes', () => {
    const root = render(
      '<button data-testid="approve" name="action" id="approve-order">x</button>',
    );
    expect(extractStableAttributes(one(root, 'button'), DEFAULT_CONFIG)).toEqual({
      'data-testid': 'approve',
      name: 'action',
      id: 'approve-order',
    });
  });

  it('drops generated values rather than trusting them', () => {
    const root = render('<button data-testid="approve" id=":r1:">x</button>');
    expect(extractStableAttributes(one(root, 'button'), DEFAULT_CONFIG)).toEqual({
      'data-testid': 'approve',
    });
  });

  it('returns an empty map when the element makes no stable claim about itself', () => {
    const root = render('<button class="Button_root__x1y2z">x</button>');
    expect(extractStableAttributes(one(root, 'button'), DEFAULT_CONFIG)).toEqual({});
  });

  it('trims whitespace so formatting is not mistaken for a change', () => {
    const root = render('<button data-testid="  approve  ">x</button>');
    expect(extractStableAttributes(one(root, 'button'), DEFAULT_CONFIG)).toEqual({
      'data-testid': 'approve',
    });
  });
});

describe('extractStructuralAttributes', () => {
  it('records a generated value as present-but-anonymous', () => {
    // Dropping it would make the hash flip when a framework starts emitting the attribute;
    // keeping the value would make it flip on every render.
    const root = render('<input name="q" type="text" data-testid=":r1:" />');
    expect(extractStructuralAttributes(one(root, 'input'), DEFAULT_CONFIG)).toEqual([
      'data-testid=*',
      'name=q',
      'type=text',
    ]);
  });

  it('excludes id, which is identity rather than structure', () => {
    const root = render('<input id="account" name="account" />');
    expect(extractStructuralAttributes(one(root, 'input'), DEFAULT_CONFIG)).toEqual([
      'name=account',
    ]);
  });
});

describe('computeLandmarkPath', () => {
  const redact = defaultRedactor;

  it('lists landmarks outermost first', () => {
    const root = render(`
      <main><section aria-label="Orders"><div><button>x</button></div></section></main>
    `);
    expect(computeLandmarkPath(one(root, 'button'), DEFAULT_CONFIG, redact)).toEqual([
      'main',
      'region:orders',
    ]);
  });

  it('skips non-landmark ancestors entirely, which is what survives sibling churn', () => {
    const root = render(`<main><div><div><div><button>x</button></div></div></div></main>`);
    expect(computeLandmarkPath(one(root, 'button'), DEFAULT_CONFIG, redact)).toEqual(['main']);
  });

  it('does not include the element itself', () => {
    const root = render(`<main><nav aria-label="Primary"><a href="/x">x</a></nav></main>`);
    expect(computeLandmarkPath(one(root, 'nav'), DEFAULT_CONFIG, redact)).toEqual(['main']);
  });

  it('returns an empty path for a top-level element', () => {
    const root = render(`<button>x</button>`);
    expect(computeLandmarkPath(one(root, 'button'), DEFAULT_CONFIG, redact)).toEqual([]);
  });
});

describe('landmarkPathSimilarity', () => {
  it('scores identical paths 1', () => {
    expect(landmarkPathSimilarity(['main', 'region:orders'], ['main', 'region:orders'])).toBe(1);
  });

  it('scores two empty paths 1 — both at the top level is agreement, not absence', () => {
    expect(landmarkPathSimilarity([], [])).toBe(1);
  });

  it('scores by shared prefix over the longer path', () => {
    expect(landmarkPathSimilarity(['main', 'region:a'], ['main', 'region:b'])).toBe(0.5);
    expect(landmarkPathSimilarity(['main'], ['main', 'region:a'])).toBe(0.5);
  });

  it('penalises an early divergence more than a late one', () => {
    const early = landmarkPathSimilarity(['main', 'region:a', 'form'], ['nav', 'region:a', 'form']);
    const late = landmarkPathSimilarity(
      ['main', 'region:a', 'form'],
      ['main', 'region:a', 'group'],
    );
    expect(late).toBeGreaterThan(early);
    expect(early).toBe(0);
  });
});

describe('computeOrdinal', () => {
  it('counts only siblings sharing the element role', () => {
    // Counting by role rather than by child index is what makes the third Approve button stay
    // the third Approve button when a heading is inserted above it.
    const root = render(`
      <div>
        <h2>Orders</h2>
        <button>A</button>
        <span>divider</span>
        <button>B</button>
        <button>C</button>
      </div>
    `);
    const buttons = [...root.querySelectorAll('button')];
    expect(buttons.map((button) => computeOrdinal(button))).toEqual([0, 1, 2]);
  });

  it('is unchanged when a differently-roled sibling is inserted above', () => {
    const root = render(`<div><button>A</button><button>B</button></div>`);
    const second = [...root.querySelectorAll('button')][1] as Element;
    expect(computeOrdinal(second)).toBe(1);

    const heading = root.ownerDocument.createElement('h2');
    one(root, 'div').insertBefore(heading, one(root, 'button'));
    expect(computeOrdinal(second)).toBe(1);
  });

  it('returns 0 for an element with no parent', () => {
    const detached = document.createElement('button');
    expect(computeOrdinal(detached)).toBe(0);
  });
});

describe('shingles', () => {
  it('produces overlapping runs of the configured size', () => {
    expect(shingles('a b c d', 3)).toEqual(['a b c', 'b c d']);
  });

  it('produces one shingle when there are fewer words than the size', () => {
    expect(shingles('a b', 3)).toEqual(['a b']);
  });

  it('returns nothing for empty text', () => {
    expect(shingles('   ', 3)).toEqual([]);
  });

  it('lowercases, so a style change to capitalisation is not a content change', () => {
    expect(shingles('Approve Order Now', 3)).toEqual(['approve order now']);
  });
});

describe('computeTextShingleHash', () => {
  it('hashes to the encoding the contract requires, even for empty text', () => {
    const root = render('<div></div>');
    expect(computeTextShingleHash(one(root, 'div'), DEFAULT_CONFIG, defaultRedactor)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('is bounded by maxShingleTextLength', () => {
    const config = resolveConfig({ maxShingleTextLength: 10 });
    const short = render(`<div id="a">${'x '.repeat(5)}</div>`);
    const long = render(`<div id="a">${'x '.repeat(500)}</div>`);

    expect(computeTextShingleHash(one(short, '#a'), config, defaultRedactor)).toBe(
      computeTextShingleHash(one(long, '#a'), config, defaultRedactor),
    );
  });
});

describe('normalizeRect', () => {
  it('converts pixels to fractions of the viewport', () => {
    expect(
      normalizeRect({ x: 640, y: 360, width: 320, height: 72 }, { width: 1280, height: 720 }),
    ).toEqual({ x: 0.5, y: 0.5, width: 0.25, height: 0.1 });
  });

  it('clamps out-of-viewport geometry into range', () => {
    const box = normalizeRect(
      { x: -100, y: 5000, width: 99999, height: 10 },
      { width: 100, height: 100 },
    );
    expect(box.x).toBe(0);
    expect(box.y).toBe(1);
    expect(box.width).toBe(1);
  });

  it('survives a zero-sized viewport and non-finite input', () => {
    const box = normalizeRect(
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { width: 0, height: 0 },
    );
    expect(box.x).toBe(0);
    expect(Number.isFinite(box.width)).toBe(true);
  });
});

describe('bboxSimilarity', () => {
  const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.05 };

  it('scores an identical box 1', () => {
    expect(bboxSimilarity(box, box)).toBe(1);
  });

  it('scores two zero-area boxes at the same origin 1', () => {
    const empty = { x: 0, y: 0, width: 0, height: 0 };
    expect(bboxSimilarity(empty, empty)).toBe(1);
  });

  it('falls with distance rather than to zero on any displacement', () => {
    // Not IoU: two renders of the same control after a scroll do not overlap at all, and IoU
    // would score that 0 where this scores it by how far it moved.
    const near = bboxSimilarity(box, { ...box, y: 0.2 });
    const far = bboxSimilarity(box, { ...box, y: 0.9 });
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });

  it('penalises a size change even at the same centre', () => {
    const resized = { x: 0.1, y: 0.1, width: 0.6, height: 0.05 };
    expect(bboxSimilarity(box, resized)).toBeLessThan(1);
  });

  it('stays within [0, 1] for opposite corners', () => {
    const score = bboxSimilarity(
      { x: 0, y: 0, width: 0.01, height: 0.01 },
      { x: 0.99, y: 0.99, width: 0.01, height: 0.01 },
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('viewportFor', () => {
  it('prefers what the caller pinned', () => {
    const root = render('<button>x</button>');
    const context = resolveContext({ viewport: { width: 800, height: 600 } });
    expect(viewportFor(one(root, 'button'), context)).toEqual({ width: 800, height: 600 });
  });

  it("falls back to the element's own window", () => {
    const root = render('<button>x</button>');
    const context = resolveContext();
    const view = one(root, 'button').ownerDocument.defaultView;

    expect(viewportFor(one(root, 'button'), context)).toEqual({
      width: view?.innerWidth,
      height: view?.innerHeight,
    });
  });
});

describe('resolveContext defaults', () => {
  it('supplies a redactor and a measurer when the caller gives neither', () => {
    const context = resolveContext();
    expect(context.redact('priya@acme.com')).toBe('[email]');
    expect(context.measure(one(render('<button>x</button>'), 'button'))).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it('tolerates an environment whose getBoundingClientRect returns a partial rect', () => {
    // Not hypothetical: happy-dom, a detached node, and older engines all return objects that
    // are missing fields. The geometry signal is worth 0.05 — it must never throw its way into
    // failing a resolution that the other six signals could have decided.
    const element = one(render('<button>x</button>'), 'button');
    const partial = { getBoundingClientRect: () => ({ x: 10 }) } as unknown as Element;
    Object.setPrototypeOf(partial, Object.getPrototypeOf(element) as object);

    const rect = resolveContext().measure(partial);
    expect(rect).toEqual({ x: 10, y: 0, width: 0, height: 0 });
  });

  it('tolerates getBoundingClientRect returning nothing at all', () => {
    const nothing = { getBoundingClientRect: () => null } as unknown as Element;
    expect(resolveContext().measure(nothing)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('resolveConfig', () => {
  it('returns the defaults untouched when nothing is overridden', () => {
    expect(resolveConfig()).toBe(DEFAULT_CONFIG);
  });

  it('merges weights one level deep so a single signal can be retuned', () => {
    const config = resolveConfig({ weights: { bbox: 0 } });
    expect(config.weights.bbox).toBe(0);
    expect(config.weights.accessibleName).toBe(DEFAULT_CONFIG.weights.accessibleName);
  });

  it('replaces non-weight fields wholesale', () => {
    const config = resolveConfig({ resolutionThreshold: 0.9, landmarkRoles: ['main'] });
    expect(config.resolutionThreshold).toBe(0.9);
    expect(config.landmarkRoles).toEqual(['main']);
  });
});

describe('computeFingerprint', () => {
  it('produces every field the contract requires', () => {
    const root = render(`
      <main><section aria-label="Orders">
        <button data-testid="approve">Approve order</button>
      </section></main>
    `);
    const button = one(root, 'button');
    const context = laidOut(new Map([[button, { x: 100, y: 200, width: 120, height: 40 }]]));

    expect(computeFingerprint(button, context)).toEqual({
      role: 'button',
      tagName: 'button',
      accessibleNameHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      accessibleNameRedacted: 'Approve order',
      landmarkPath: ['main', 'region:orders'],
      stableAttributes: { 'data-testid': 'approve' },
      ordinal: 0,
      textShingleHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      bbox: { x: 0.1, y: 0.2, width: 0.12, height: 0.04 },
    });
  });

  it('honours a custom redactor, so a tenant can be stricter', () => {
    const root = render('<button>Approve Acme Industrial</button>');
    const fingerprint = computeFingerprint(one(root, 'button'), {
      redact: (text) => text.replace(/Acme Industrial/g, '[customer]'),
    });

    expect(fingerprint.accessibleNameRedacted).toBe('Approve [customer]');
  });

  it('measures a zero rect for an element the layout does not mention', () => {
    const root = render('<button>x</button>');
    const context = laidOut(new Map());
    expect(computeFingerprint(one(root, 'button'), context).bbox).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it('measures through getBoundingClientRect when no measure hook is given', () => {
    // happy-dom does no layout, so this is the zero case — which is exactly why the geometry
    // signal has to be able to declare itself inapplicable.
    const root = render('<button>x</button>');
    expect(computeFingerprint(one(root, 'button')).bbox).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});
