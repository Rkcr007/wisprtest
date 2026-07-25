import { describe, expect, it } from 'vitest';

import { computeAccessibleName } from './accname.js';
import { one, render } from './testing.js';

describe('computeAccessibleName — the accname precedence order', () => {
  it('prefers aria-labelledby over everything else', () => {
    const root = render(`
      <span id="lbl">Approve order</span>
      <button aria-labelledby="lbl" aria-label="ignored" title="also ignored">Nope</button>
    `);
    expect(computeAccessibleName(one(root, 'button'))).toBe('Approve order');
  });

  it('concatenates aria-labelledby targets in the order listed, not document order', () => {
    const root = render(`
      <span id="second">order</span>
      <span id="first">Approve</span>
      <button aria-labelledby="first second"></button>
    `);
    expect(computeAccessibleName(one(root, 'button'))).toBe('Approve order');
  });

  it('skips aria-labelledby ids that do not resolve', () => {
    const root = render(`
      <span id="present">Approve</span>
      <button aria-labelledby="missing present"></button>
    `);
    expect(computeAccessibleName(one(root, 'button'))).toBe('Approve');
  });

  it('falls through to aria-label when every labelledby id is dangling', () => {
    const root = render(`<button aria-labelledby="gone" aria-label="Approve"></button>`);
    expect(computeAccessibleName(one(root, 'button'))).toBe('Approve');
  });

  it('terminates on a labelledby cycle rather than recursing forever', () => {
    // Step 2B of the algorithm: inside a dereference, the target's own aria-labelledby is not
    // followed. Without that rule this pair recurses until the stack gives out.
    const root = render(`
      <button id="a" aria-labelledby="b">Alpha</button>
      <button id="b" aria-labelledby="a">Beta</button>
    `);
    expect(computeAccessibleName(one(root, '#a'))).toBe('Beta');
  });

  it('prefers aria-label over a native label', () => {
    const root = render(`
      <label for="f">Native</label>
      <input id="f" aria-label="Overridden" />
    `);
    expect(computeAccessibleName(one(root, 'input'))).toBe('Overridden');
  });

  it('ignores an empty aria-label and keeps looking', () => {
    const root = render(`
      <label for="f">Account name</label>
      <input id="f" aria-label="   " />
    `);
    expect(computeAccessibleName(one(root, 'input'))).toBe('Account name');
  });
});

describe('computeAccessibleName — native host-language labelling', () => {
  it('uses label[for]', () => {
    const root = render(`<label for="acct">Account</label><input id="acct" />`);
    expect(computeAccessibleName(one(root, 'input'))).toBe('Account');
  });

  it('uses a wrapping label, excluding the control itself', () => {
    // The exclusion matters: without it a select's option text lands in its own label.
    const root = render(`
      <label>Terms
        <select><option>Net 30</option><option>Net 60</option></select>
      </label>
    `);
    expect(computeAccessibleName(one(root, 'select'))).toBe('Terms');
  });

  it('uses fieldset > legend', () => {
    const root = render(`<fieldset><legend>Billing address</legend><input /></fieldset>`);
    expect(computeAccessibleName(one(root, 'fieldset'))).toBe('Billing address');
  });

  it('uses table > caption', () => {
    const root = render(`<table><caption>Open orders</caption><tr><td>x</td></tr></table>`);
    expect(computeAccessibleName(one(root, 'table'))).toBe('Open orders');
  });

  it('uses figure > figcaption', () => {
    const root = render(
      `<figure><img src="a.png" alt="" /><figcaption>Chart</figcaption></figure>`,
    );
    expect(computeAccessibleName(one(root, 'figure'))).toBe('Chart');
  });

  it('uses img alt', () => {
    const root = render(`<img src="logo.png" alt="Acme Industrial" />`);
    expect(computeAccessibleName(one(root, 'img'))).toBe('Acme Industrial');
  });

  it('treats an explicit empty alt as a decision, not as a missing name', () => {
    // alt="" declares the image decorative. Falling through to `title` would give it a name the
    // author deliberately withheld.
    const root = render(`<img src="spacer.gif" alt="" title="spacer" />`);
    expect(computeAccessibleName(one(root, 'img'))).toBe('');
  });

  it('uses the value of a submit-style input', () => {
    const root = render(`<input type="submit" value="Approve order" />`);
    expect(computeAccessibleName(one(root, 'input'))).toBe('Approve order');
  });

  it('falls back to the implicit label a browser announces for a bare submit', () => {
    const root = render(`<input type="submit" /><input type="reset" />`);
    expect(computeAccessibleName(one(root, '[type=submit]'))).toBe('Submit');
    expect(computeAccessibleName(one(root, '[type=reset]'))).toBe('Reset');
  });

  it('uses optgroup label', () => {
    const root = render(`<select><optgroup label="Recent"><option>A</option></optgroup></select>`);
    expect(computeAccessibleName(one(root, 'optgroup'))).toBe('Recent');
  });
});

describe('computeAccessibleName — placeholder, content and title', () => {
  it('uses placeholder when there is no label', () => {
    const root = render(`<input placeholder="Search orders" />`);
    expect(computeAccessibleName(one(root, 'input'))).toBe('Search orders');
  });

  it('prefers a label over a placeholder', () => {
    const root = render(`<label for="q">Search</label><input id="q" placeholder="Type here" />`);
    expect(computeAccessibleName(one(root, 'input'))).toBe('Search');
  });

  it('names from content for roles that allow it', () => {
    const root = render(`<button>  Approve   order  </button>`);
    expect(computeAccessibleName(one(root, 'button'))).toBe('Approve order');
  });

  it('does not name a textbox from its content', () => {
    // A textbox names from its label, never from what the user has typed into it. Getting this
    // wrong would put customer input straight into the fingerprint.
    const root = render(`<div role="textbox" contenteditable>priya@acme.com</div>`);
    expect(computeAccessibleName(one(root, '[role=textbox]'))).toBe('');
  });

  it('folds a nested aria-label into the content name', () => {
    const root = render(`<button><span aria-label="Approve">✓</span> order</button>`);
    expect(computeAccessibleName(one(root, 'button'))).toBe('Approve order');
  });

  it('folds a nested img alt into the content name', () => {
    const root = render(`<button><img src="tick.png" alt="Approve" /> order</button>`);
    expect(computeAccessibleName(one(root, 'button'))).toBe('Approve order');
  });

  it('skips aria-hidden descendants', () => {
    const root = render(`<button><span aria-hidden="true">✓</span>Approve</button>`);
    expect(computeAccessibleName(one(root, 'button'))).toBe('Approve');
  });

  it('skips script and style descendants', () => {
    const root = render(`<button><style>.a{color:red}</style>Approve<script>x=1</script></button>`);
    expect(computeAccessibleName(one(root, 'button'))).toBe('Approve');
  });

  it('uses title as the last resort', () => {
    const root = render(`<div title="Order total"></div>`);
    expect(computeAccessibleName(one(root, 'div'))).toBe('Order total');
  });

  it('returns an empty string for a genuinely unnamed element', () => {
    const root = render(`<div><span></span></div>`);
    expect(computeAccessibleName(one(root, 'span'))).toBe('');
  });
});
