import type { AliasWriteback, EscalateRequest } from 'protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { createResolver, type Resolver } from './resolver.js';
import { buildSnapshot, fakeEmbedder, type ScreenSpec } from './testing.js';
import type { EscalationOutcome } from './tier2.js';

/**
 * Tier 2 — escalation, and the write-back that is the point of it.
 *
 * The assertions that matter most here are the two the phase calls out by name: that a customer's
 * data never reaches a model provider (the request is checked for the raw email that went in), and
 * that a successful escalation *learns* — because a T2 without a write-back is, in CLAUDE.md's
 * words, a slower competitor. The rest pin the escalation's boundaries: it runs only after T0 and
 * T1 have both missed, it never returns a pick the model invented, and every failure lands the
 * tester on a disambiguation list rather than a hang or a guess.
 */

const STATE = 'a'.repeat(64);

/** What the escalation transport will do on each call, set per test. */
let outcomes: EscalationOutcome[] = [];
let requests: EscalateRequest[] = [];
let learned: AliasWriteback[] = [];

function resolverWith(overrides: { escalate?: boolean } = {}): Resolver {
  document.body.innerHTML = `
    <main>
      <section aria-label="Orders">
        <button data-testid="approve">Approve order</button>
        <button data-testid="hold">Put on hold</button>
      </section>
    </main>
  `;
  const live = [...document.body.querySelectorAll('button')];
  const screens: ScreenSpec[] = [
    {
      stateFingerprint: STATE,
      routePattern: '/orders',
      label: 'Orders',
      elements: [
        { element: live[0] as Element, elementKey: 'orders.orders.approve' },
        { element: live[1] as Element, elementKey: 'orders.orders.hold' },
      ],
    },
  ];
  const built = buildSnapshot(screens);
  idByKey = built.idByKey;

  return createResolver({
    snapshot: built.snapshot,
    // Both controls sit near the query but below the T1 bar, so a phrase reaches T2 *and* T1 has
    // a ranked pair to fall back to — the two conditions every escalation here is tested against.
    embedder: fakeEmbedder({
      'sign off on this order': [1, 0],
      'put this one aside': [1, 0],
      'Approve order': [0.5, 0.866],
      'Put on hold': [0.45, 0.893],
    }),
    config: { queryInstruction: '' },
    source: { current: () => ({ stateFingerprint: STATE, candidates: live }) },
    now: () => 0,
    onAlias: (writeback) => learned.push(writeback),
    ...(overrides.escalate === false
      ? {}
      : {
          escalate: (request) => {
            requests.push(request);
            const next = outcomes.shift();
            return Promise.resolve(next ?? { ok: false, reason: 'unavailable' });
          },
        }),
  });
}

let idByKey = new Map<string, string>();

function idOf(key: string): string {
  const id = idByKey.get(key);
  if (id === undefined) throw new Error(`no id for ${key}`);
  return id;
}

function pick(key: string, confidence: number): EscalationOutcome {
  return {
    ok: true,
    response: { elementId: idOf(key), confidence, reasoning: 'the approve control' },
  };
}

beforeEach(() => {
  outcomes = [];
  requests = [];
  learned = [];
});

describe('escalation boundaries', () => {
  it('does not escalate a phrase T0 resolves', async () => {
    const resolver = resolverWith();

    const result = await resolver.resolve('Approve order');

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.tier).toBe('T0');
    // The whole latency argument for T0 collapses if it still pays for a network hop.
    expect(requests).toHaveLength(0);
    expect(learned).toHaveLength(0);
  });

  it('escalates only once T0 and T1 have both missed', async () => {
    const resolver = resolverWith();
    outcomes = [pick('orders.orders.approve', 0.93)];

    const result = await resolver.resolve('sign off on this order');

    expect(requests).toHaveLength(1);
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.tier).toBe('T2');
    expect(result.elementKey).toBe('orders.orders.approve');
  });

  it('stops at T1 when no transport is configured', async () => {
    const resolver = resolverWith({ escalate: false });

    const result = await resolver.resolve('sign off on this order');

    expect(result.tier).toBe('T1');
    expect(requests).toHaveLength(0);
  });

  it('sends the scoped candidate set, not the document', async () => {
    const resolver = resolverWith();
    outcomes = [pick('orders.orders.approve', 0.9)];

    await resolver.resolve('sign off on this order');

    const [request] = requests;
    if (request === undefined) throw new Error('no escalation was sent');
    expect(request.candidates).toHaveLength(2);
    expect(request.candidates.map((candidate) => candidate.elementKey).sort()).toEqual([
      'orders.orders.approve',
      'orders.orders.hold',
    ]);
    expect(request.stateFingerprint).toBe(STATE);
  });
});

describe('PII', () => {
  it('redacts the utterance before it leaves the device', async () => {
    const resolver = resolverWith();
    outcomes = [pick('orders.orders.approve', 0.9)];

    await resolver.resolve("approve jane.doe@acme.com's order");

    const [request] = requests;
    if (request === undefined) throw new Error('no escalation was sent');
    // The procurement-blocking assertion from CLAUDE.md § "PII rule": a customer's data must never
    // reach a model provider. The gateway redacts again, but a leak here would already be one.
    expect(request.utterance).not.toContain('jane.doe@acme.com');
    expect(request.utterance).toContain('[email]');
  });

  it('redacts candidate labels', async () => {
    document.body.innerHTML = `
      <main>
        <section aria-label="Orders">
          <button data-testid="owner">Owner jane.doe@acme.com</button>
          <button data-testid="hold">Put on hold</button>
        </section>
      </main>
    `;
    const live = [...document.body.querySelectorAll('button')];
    const built = buildSnapshot([
      {
        stateFingerprint: STATE,
        routePattern: '/orders',
        label: 'Orders',
        elements: [
          { element: live[0] as Element, elementKey: 'orders.orders.owner' },
          { element: live[1] as Element, elementKey: 'orders.orders.hold' },
        ],
      },
    ]);
    const resolver = createResolver({
      snapshot: built.snapshot,
      embedder: fakeEmbedder({}),
      config: { queryInstruction: '' },
      source: { current: () => ({ stateFingerprint: STATE, candidates: live }) },
      now: () => 0,
      escalate: (request) => {
        requests.push(request);
        return Promise.resolve({ ok: false, reason: 'not_found' });
      },
    });

    await resolver.resolve('the one for that customer');

    const [request] = requests;
    if (request === undefined) throw new Error('no escalation was sent');
    const labels = request.candidates.map((candidate) => candidate.label).join(' ');
    expect(labels).not.toContain('jane.doe@acme.com');
    expect(labels).toContain('[email]');
  });
});

describe('the write-back loop', () => {
  it('learns a phrase a T2 pick resolved above threshold', async () => {
    const resolver = resolverWith();
    outcomes = [pick('orders.orders.approve', 0.93)];

    await resolver.resolve('Sign OFF on this order!');

    expect(learned).toHaveLength(1);
    expect(learned[0]).toEqual({
      // Normalised by the same function T0's alias index folds its keys with — the detail the
      // whole compounding loop rests on. Stored any other way, the alias would never fire.
      phrase: 'sign off on this order',
      elementId: idOf('orders.orders.approve'),
      stateFingerprint: STATE,
      source: 't2_writeback',
    });
  });

  it('does not learn a pick below the confidence threshold', async () => {
    const resolver = resolverWith();
    outcomes = [pick('orders.orders.approve', 0.4)];

    const result = await resolver.resolve('sign off on this order');

    expect(result.outcome).toBe('ambiguous');
    // Persisting an uncertain pick would make the same uncertain answer instant — and confident —
    // the next time the phrase is said.
    expect(learned).toHaveLength(0);
  });

  it('learns a tester correction, which outranks anything the model said', async () => {
    const resolver = resolverWith();
    outcomes = [pick('orders.orders.approve', 0.4)];

    const ambiguous = await resolver.resolve('put this one aside');
    expect(ambiguous.outcome).toBe('ambiguous');

    const open = resolver.pending();
    if (open === null) throw new Error('expected a disambiguation');
    // "two" is the runner-up — the hold button, which is what the tester actually meant.
    const chosen = resolver.choose(2);

    expect(chosen?.outcome).toBe('resolved');
    expect(learned).toHaveLength(1);
    expect(learned[0]?.source).toBe('manual');
    expect(learned[0]?.phrase).toBe('put this one aside');
    expect(learned[0]?.elementId).toBe(open.choices[1]?.candidate.elementId);
    // Answered: the list is closed, so the next utterance is a command again.
    expect(resolver.pending()).toBeNull();
  });
});

describe('when the model is wrong or the gateway is not there', () => {
  it('refuses an element id that is not in the live scope', async () => {
    const resolver = resolverWith();
    outcomes = [
      {
        ok: true,
        response: {
          elementId: '11111111-1111-4111-8111-111111111111',
          confidence: 0.99,
          reasoning: 'confidently wrong',
        },
      },
    ];

    const result = await resolver.resolve('sign off on this order');

    // A hallucinated id executed at 0.99 confidence is the false execution the release gate exists
    // to prevent. It falls back to what T1 knew instead.
    expect(result.tier).toBe('T1');
    expect(learned).toHaveLength(0);
  });

  it('falls back to the T1 candidates on a timeout', async () => {
    const resolver = resolverWith();
    outcomes = [{ ok: false, reason: 'timeout' }];

    const result = await resolver.resolve('sign off on this order');

    expect(result.outcome).not.toBe('resolved');
    expect(result.tier).toBe('T1');
    expect(learned).toHaveLength(0);
  });

  it('falls back when the transport itself throws', async () => {
    const built = buildSnapshotForThrow();
    const resolver = createResolver({
      snapshot: built.snapshot,
      embedder: fakeEmbedder({}),
      config: { queryInstruction: '' },
      source: { current: () => ({ stateFingerprint: STATE, candidates: built.live }) },
      now: () => 0,
      escalate: () => Promise.reject(new Error('worker gone')),
      onAlias: (writeback) => learned.push(writeback),
    });

    const result = await resolver.resolve('sign off on this order');

    // An exception on the hot path is a hung utterance; the tester gets the T1 list instead.
    expect(result.tier).toBe('T1');
    expect(learned).toHaveLength(0);
  });
});

function buildSnapshotForThrow(): {
  snapshot: ReturnType<typeof buildSnapshot>['snapshot'];
  live: Element[];
} {
  document.body.innerHTML = `
    <main>
      <section aria-label="Orders">
        <button data-testid="approve">Approve order</button>
        <button data-testid="hold">Put on hold</button>
      </section>
    </main>
  `;
  const live = [...document.body.querySelectorAll('button')];
  const built = buildSnapshot([
    {
      stateFingerprint: STATE,
      routePattern: '/orders',
      label: 'Orders',
      elements: [
        { element: live[0] as Element, elementKey: 'orders.orders.approve' },
        { element: live[1] as Element, elementKey: 'orders.orders.hold' },
      ],
    },
  ]);
  return { snapshot: built.snapshot, live };
}
