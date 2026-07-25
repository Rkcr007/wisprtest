import { describe, expect, it } from 'vitest';

import { DEFAULT_SIGNAL_WEIGHTS, resolveContext, type SignalName } from './config.js';
import { computeFingerprint } from './fingerprint.js';
import {
  compareFingerprints,
  scoreCandidate,
  scoreCandidateDetailed,
  textSimilarity,
} from './score.js';
import { at, laidOut, one, render } from './testing.js';

describe('signal weights', () => {
  it('are the values in the ARCHITECTURE table and sum to 1', () => {
    expect(DEFAULT_SIGNAL_WEIGHTS).toEqual({
      role: 0.2,
      accessibleName: 0.25,
      landmarkPath: 0.15,
      stableAttributes: 0.2,
      ordinal: 0.08,
      textShingle: 0.07,
      bbox: 0.05,
    });
    const names: SignalName[] = [
      'role',
      'accessibleName',
      'landmarkPath',
      'stableAttributes',
      'ordinal',
      'textShingle',
      'bbox',
    ];
    const total = names.reduce((sum, name) => sum + DEFAULT_SIGNAL_WEIGHTS[name], 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe('textSimilarity', () => {
  it('scores identical strings 1 and disjoint strings 0', () => {
    expect(textSimilarity('Approve', 'Approve')).toBe(1);
    expect(textSimilarity('Approve', 'Reject')).toBe(0);
  });

  it('scores a partial overlap between the two, by word', () => {
    // Dice over words: 1 shared of 1 + 2 total → 2/3.
    expect(textSimilarity('Approve', 'Approve order')).toBeCloseTo(2 / 3, 6);
  });

  it('treats two empty strings as agreement and one empty as disagreement', () => {
    expect(textSimilarity('', '')).toBe(1);
    expect(textSimilarity('Approve', '')).toBe(0);
  });

  it('ignores case and punctuation', () => {
    expect(textSimilarity('Approve order', 'APPROVE, ORDER!')).toBe(1);
  });

  it('does not let a repeated word count twice', () => {
    // "approve approve" against "approve" shares one token, not two.
    expect(textSimilarity('approve approve', 'approve')).toBeCloseTo(2 / 3, 6);
  });

  it('ranks a word-level near miss above an unrelated string', () => {
    const near = textSimilarity('pending filter', 'pending orders filter');
    const far = textSimilarity('pending filter', 'export spreadsheet');
    expect(near).toBeGreaterThan(far);
    expect(far).toBe(0);
  });
});

describe('scoreCandidate — an unchanged element', () => {
  it('scores exactly 1 against itself', () => {
    const root = render(`
      <main><section aria-label="Orders">
        <button data-testid="approve">Approve order</button>
      </section></main>
    `);
    const button = one(root, 'button');
    const fingerprint = computeFingerprint(button);

    expect(scoreCandidate(fingerprint, button)).toBe(1);
  });

  it('scores 1 against an identical element re-rendered elsewhere in the same position', () => {
    const markup = `<main><section aria-label="Orders">
      <button data-testid="approve">Approve order</button>
    </section></main>`;

    const first = computeFingerprint(one(render(markup), 'button'));
    const second = one(render(markup), 'button');

    expect(scoreCandidate(first, second)).toBe(1);
  });
});

describe('scoreCandidate — applicability and weight redistribution', () => {
  it('does not cap an element that carries no stable attributes', () => {
    // The bug this guards against: a fixed denominator would cap every element without a
    // data-testid at 0.80 no matter how perfectly the other six signals matched, forcing the
    // resolution threshold down and making testid-bearing elements easier to confuse.
    const root = render(`<main><button>Approve order</button></main>`);
    const button = one(root, 'button');

    expect(scoreCandidate(computeFingerprint(button), button)).toBe(1);
  });

  it('drops the stable-attribute signal entirely when neither side has one', () => {
    const root = render(`<main><button>Approve</button></main>`);
    const button = one(root, 'button');
    const detail = scoreCandidateDetailed(computeFingerprint(button), button, resolveContext());

    expect(detail.signals.stableAttributes).toBeUndefined();
    expect(detail.evidence).toBeCloseTo(
      1 - DEFAULT_SIGNAL_WEIGHTS.stableAttributes - DEFAULT_SIGNAL_WEIGHTS.bbox,
      10,
    );
  });

  it('drops the geometry signal when neither side was laid out', () => {
    // happy-dom performs no layout, and the indexer runs headless. Scoring zero-area boxes as a
    // perfect match would hand every candidate the same free 0.05, which is noise, not evidence.
    const root = render(`<button>Approve</button>`);
    const button = one(root, 'button');
    const detail = scoreCandidateDetailed(computeFingerprint(button), button, resolveContext());

    expect(detail.signals.bbox).toBeUndefined();
  });

  it('applies the geometry signal when a layout is supplied', () => {
    const root = render(`<button>Approve</button>`);
    const button = one(root, 'button');
    const context = laidOut(new Map([[button, { x: 100, y: 40, width: 120, height: 32 }]]));

    const detail = scoreCandidateDetailed(
      computeFingerprint(button, context),
      button,
      resolveContext(context),
    );

    expect(detail.signals.bbox).toBe(1);
    expect(detail.evidence).toBeCloseTo(1 - DEFAULT_SIGNAL_WEIGHTS.stableAttributes, 10);
  });

  it('counts a lost stable attribute as a mismatch, not as inapplicable', () => {
    const root = render(`<button data-testid="approve">Approve</button>`);
    const button = one(root, 'button');
    const stored = computeFingerprint(button);

    button.removeAttribute('data-testid');
    const detail = scoreCandidateDetailed(stored, button, resolveContext());

    expect(detail.signals.stableAttributes).toBe(0);
    expect(detail.score).toBeLessThan(1);
  });

  it('does not penalise an element that has newly gained a stable attribute', () => {
    // A team adding test hooks to their app should not make it harder to resolve.
    const root = render(`<button>Approve</button>`);
    const button = one(root, 'button');
    const stored = computeFingerprint(button);

    button.setAttribute('data-testid', 'approve');

    expect(scoreCandidate(stored, button)).toBe(1);
  });

  it('reports zero when every weight has been overridden away', () => {
    const root = render(`<button>Approve</button>`);
    const button = one(root, 'button');
    const zeroed = resolveContext({
      config: {
        weights: {
          role: 0,
          accessibleName: 0,
          landmarkPath: 0,
          stableAttributes: 0,
          ordinal: 0,
          textShingle: 0,
          bbox: 0,
        },
      },
    });

    expect(scoreCandidateDetailed(computeFingerprint(button), button, zeroed).score).toBe(0);
  });
});

describe('scoreCandidate — per-signal behaviour', () => {
  it('scores role as all or nothing', () => {
    const root = render(`<div><button>Go</button><a href="/go">Go</a></div>`);
    const button = one(root, 'button');
    const link = one(root, 'a');

    const detail = scoreCandidateDetailed(computeFingerprint(button), link, resolveContext());
    expect(detail.signals.role).toBe(0);
  });

  it('grades the accessible name rather than treating a rename as total loss', () => {
    const root = render(`<button>Approve</button>`);
    const button = one(root, 'button');
    const stored = computeFingerprint(button);

    button.textContent = 'Approve order';
    const detail = scoreCandidateDetailed(stored, button, resolveContext());

    expect(detail.signals.accessibleName).toBeCloseTo(2 / 3, 6);
    expect(detail.signals.accessibleName).toBeGreaterThan(0);
    expect(detail.signals.accessibleName).toBeLessThan(1);
  });

  it('decays the ordinal signal with distance rather than dropping to zero', () => {
    const root = render(`<ul>${'<li><button>Row</button></li>'.repeat(6)}</ul>`);
    const buttons = [...root.querySelectorAll('button')];
    const [first, second, sixth] = [buttons[0], buttons[1], buttons[5]];
    if (first === undefined || second === undefined || sixth === undefined)
      throw new Error('fixture');

    // Every button is inside its own <li>, so the ordinal is measured across the <li> siblings.
    const storedFirst = computeFingerprint(one(root, 'li'));
    const lis = [...root.querySelectorAll('li')];
    const near = scoreCandidateDetailed(storedFirst, at(lis, 1), resolveContext());
    const far = scoreCandidateDetailed(storedFirst, at(lis, 5), resolveContext());

    expect(near.signals.ordinal).toBeCloseTo(1 / 2, 6);
    expect(far.signals.ordinal).toBeCloseTo(1 / 6, 6);
    expect(near.signals.ordinal ?? 0).toBeGreaterThan(far.signals.ordinal ?? 0);
  });

  it('scores the landmark path by shared prefix, from the outside in', () => {
    const root = render(`
      <main>
        <section aria-label="Orders"><button id="a">Approve</button></section>
        <section aria-label="Invoices"><button id="b">Approve</button></section>
      </main>
    `);
    const inOrders = one(root, '#a');
    const inInvoices = one(root, '#b');

    const detail = scoreCandidateDetailed(
      computeFingerprint(inOrders),
      inInvoices,
      resolveContext(),
    );

    // Both are under `main`; they diverge at the region. One of two segments shared.
    expect(detail.signals.landmarkPath).toBeCloseTo(0.5, 6);
  });

  it('scores the text shingle as a digest — equal or not', () => {
    const root = render(`<div id="a">alpha beta gamma</div><div id="b">alpha beta delta</div>`);
    const detail = scoreCandidateDetailed(
      computeFingerprint(one(root, '#a')),
      one(root, '#b'),
      resolveContext(),
    );
    expect(detail.signals.textShingle).toBe(0);
  });
});

describe('compareFingerprints', () => {
  it('is symmetric for every signal except the stable-attribute asymmetry', () => {
    const root = render(`
      <main><button data-testid="approve">Approve order</button></main>
    `);
    const button = one(root, 'button');
    const a = computeFingerprint(button);

    button.textContent = 'Approve';
    const b = computeFingerprint(button);

    const forward = compareFingerprints(a, b, resolveContext());
    const backward = compareFingerprints(b, a, resolveContext());
    expect(forward.score).toBeCloseTo(backward.score, 10);
  });

  it('never returns a score outside [0, 1]', () => {
    const root = render(`
      <main><section aria-label="Orders">
        <button data-testid="a">Approve</button>
      </section></main>
      <footer><a href="/x">Totally different</a></footer>
    `);
    const button = one(root, 'button');
    const link = one(root, 'a');

    for (const score of [
      scoreCandidate(computeFingerprint(button), link),
      scoreCandidate(computeFingerprint(link), button),
      scoreCandidate(computeFingerprint(button), button),
    ]) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
