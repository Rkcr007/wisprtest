import { describe, expect, it } from 'vitest';

import { structuralHash } from './structural-hash.js';
import { one, render } from './testing.js';

/**
 * The exclusions are the design. A hash that moved when the data moved would fire on every page
 * of every list, and a drift signal that cries wolf is worse than none because teams learn to
 * ignore it. Each test below names the thing that must *not* change it.
 */

const PAGE = `
  <main>
    <section aria-label="Orders">
      <table>
        <tr><td><button data-testid="approve">Approve</button></td></tr>
      </table>
    </section>
  </main>
`;

function hashOf(html: string, selector = 'main'): string {
  return structuralHash(one(render(html), selector));
}

describe('structuralHash — what it ignores', () => {
  it('ignores text content', () => {
    expect(hashOf(PAGE.replace('Approve', 'Approve order 4903'))).toBe(hashOf(PAGE));
  });

  it('ignores whitespace and formatting', () => {
    const reformatted = PAGE.replace(/\s+/g, ' ');
    expect(hashOf(reformatted)).toBe(hashOf(PAGE));
  });

  it('ignores class and style', () => {
    const restyled = PAGE.replace('<main>', '<main class="v2" style="display:grid">');
    expect(hashOf(restyled)).toBe(hashOf(PAGE));
  });

  it('ignores id, whether hand-written or generated', () => {
    expect(hashOf(PAGE.replace('<main>', '<main id="page-root">'))).toBe(hashOf(PAGE));
    expect(hashOf(PAGE.replace('<main>', '<main id=":r4:">'))).toBe(hashOf(PAGE));
  });

  it('ignores content-bearing attributes', () => {
    const labelled = PAGE.replace('data-testid="approve"', 'data-testid="approve" title="Approve"');
    expect(hashOf(labelled)).toBe(hashOf(PAGE));
  });

  it('ignores comment nodes', () => {
    expect(hashOf(PAGE.replace('<table>', '<!-- rows below --><table>'))).toBe(hashOf(PAGE));
  });
});

describe('structuralHash — what it detects', () => {
  it('detects an added element', () => {
    const added = PAGE.replace('</table>', '<tr><td><button>Reject</button></td></tr></table>');
    expect(hashOf(added)).not.toBe(hashOf(PAGE));
  });

  it('detects a removed element', () => {
    expect(hashOf(PAGE.replace('<button data-testid="approve">Approve</button>', ''))).not.toBe(
      hashOf(PAGE),
    );
  });

  it('detects a role change even when the tag is unchanged', () => {
    const rerolled = PAGE.replace(
      '<button data-testid="approve">',
      '<button role="link" data-testid="approve">',
    );
    expect(hashOf(rerolled)).not.toBe(hashOf(PAGE));
  });

  it('detects a changed data-testid, because that is component identity', () => {
    expect(hashOf(PAGE.replace('"approve"', '"confirm"'))).not.toBe(hashOf(PAGE));
  });

  it('detects an attribute appearing, even when its value is generated', () => {
    // Recorded as present-but-anonymous, so the hash moves once when a framework starts
    // emitting it and then stays put across renders.
    const withGenerated = PAGE.replace('<table>', '<table data-testid=":r1:">');
    expect(hashOf(withGenerated)).not.toBe(hashOf(PAGE));
  });

  it('does not move when a generated attribute value is regenerated', () => {
    const first = hashOf(PAGE.replace('<table>', '<table data-testid=":r1:">'));
    const second = hashOf(PAGE.replace('<table>', '<table data-testid=":r99:">'));
    expect(second).toBe(first);
  });

  it('detects reparenting that preserves document order', () => {
    // The nesting terminator earns its keep: without it these two flatten to the same sequence.
    expect(hashOf('<main><a href="/x"></a><span></span></main>')).not.toBe(
      hashOf('<main><a href="/x"><span></span></a></main>'),
    );
  });

  it('detects a reorder of unlike siblings', () => {
    expect(hashOf('<main><button></button><a href="/x"></a></main>')).not.toBe(
      hashOf('<main><a href="/x"></a><button></button></main>'),
    );
  });
});

describe('structuralHash — bounds and configuration', () => {
  function nest(depth: number): string {
    return `<main>${'<div>'.repeat(depth)}<button data-testid="deep"></button>${'</div>'.repeat(depth)}</main>`;
  }

  it('stops descending at maxStructuralDepth', () => {
    // Beyond the cap the two trees are identical to the hash, because neither is visited.
    const shallowCap = { maxStructuralDepth: 2 };
    expect(structuralHash(one(render(nest(6)), 'main'), shallowCap)).toBe(
      structuralHash(one(render(nest(9)), 'main'), shallowCap),
    );
  });

  it('still distinguishes trees that differ above the cap', () => {
    const shallowCap = { maxStructuralDepth: 2 };
    expect(structuralHash(one(render(nest(1)), 'main'), shallowCap)).not.toBe(
      structuralHash(one(render(nest(9)), 'main'), shallowCap),
    );
  });

  it('sees a difference at full depth that a shallow cap hides', () => {
    expect(structuralHash(one(render(nest(6)), 'main'))).not.toBe(
      structuralHash(one(render(nest(9)), 'main')),
    );
  });

  it('honours a custom structural attribute list', () => {
    const html = '<main><input name="q" data-track="analytics" /></main>';
    const withTracking = { structuralAttributeNames: ['data-track'] };

    expect(structuralHash(one(render(html), 'main'), withTracking)).not.toBe(
      structuralHash(one(render(html.replace('analytics', 'other')), 'main'), withTracking),
    );
    // The default list ignores it entirely.
    expect(structuralHash(one(render(html), 'main'))).toBe(
      structuralHash(one(render(html.replace('analytics', 'other')), 'main')),
    );
  });

  it('produces a digest in the encoding the contract requires, even for a leaf', () => {
    expect(hashOf('<main></main>')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls', () => {
    expect(hashOf(PAGE)).toBe(hashOf(PAGE));
  });
});
