import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  computeFingerprint,
  computeStateFingerprint,
  interactiveCandidates,
  type PageContext,
  type Rect,
} from 'fingerprint';
import { Window } from 'happy-dom';
import { AliasWritebackBatch, EscalateRequest, type Alias, type MemorySnapshot } from 'protocol';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { createAliasClient } from '../../src/background/alias-client.js';
import { createEscalateClient } from '../../src/background/escalate-client.js';
import { createMemoryClient } from '../../src/background/memory-client.js';
import {
  createResolver,
  createWritebackQueue,
  type Resolver,
  type WritebackQueue,
} from '../../src/resolver/index.js';
import { buildSnapshot, fakeEmbedder } from '../../src/resolver/testing.js';

/**
 * The compounding loop, end to end.
 *
 * docs/BUILD-PLAN.md Phase 11: "an unknown phrasing resolves at T2, the alias is persisted, a fresh
 * snapshot is loaded, and the same phrasing then resolves at T0." This runs that whole circuit
 * through the real components — the resolver's tiers, the escalation client, the write-back queue,
 * the alias client and the memory client — over real HTTP, with nothing mocked between them.
 *
 * ## What stands in for the gateway, and why that is honest
 *
 * The control plane here is a small HTTP server implementing the two routes the extension calls,
 * validating every request against `packages/protocol` exactly as the gateway does and storing
 * aliases in a map. The gateway's own half of this loop — RLS-scoped upsert, dedupe on
 * `(memory_version_id, phrase)`, snapshot cache invalidation — is covered against the real Postgres
 * by `pnpm --filter gateway test:memory` and `test:resolve`. What is unproven *without* this suite
 * is the extension's half: that the phrase it learns is normalised the way T0 folds its alias keys,
 * that the write-back survives the queue and the wire, and that a reloaded snapshot actually turns
 * the escalation into a local hit. A fake gateway is the right boundary for that question, and the
 * assertions below are about the extension's behaviour on both sides of it.
 *
 * The environment is `node`, not happy-dom, so `fetch` is the platform's; the DOM the fingerprints
 * are computed from is created explicitly with a happy-dom `Window` — the same split
 * `test/resolver/fixture-resolution.test.ts` uses.
 */

const ROUTE = '/orders';
const TOKEN = 'scoped-token-for-the-tab';
const UTTERANCE = 'Sign OFF on this order';

/** A stable per-element box by document order, standing in for the layout happy-dom lacks. */
function measureFor(doc: Document): (element: Element) => Rect {
  const order = new Map<Element, number>();
  let index = 0;
  for (const element of doc.querySelectorAll('*')) order.set(element, index++);
  return (element) => ({ x: 0, y: (order.get(element) ?? 0) * 24, width: 160, height: 20 });
}

interface Indexed {
  readonly snapshot: MemorySnapshot;
  readonly elements: readonly Element[];
  readonly context: PageContext;
  readonly stateFingerprint: string;
  readonly idByKey: ReadonlyMap<string, string>;
}

/** Fingerprint the page once, exactly as an indexer crawl would, and build memory from it. */
function indexPage(): Indexed {
  const window = new Window();
  window.document.write(`
    <html><body>
      <main>
        <section aria-label="Orders">
          <button data-testid="approve">Approve order</button>
          <button data-testid="hold">Put on hold</button>
        </section>
      </main>
    </body></html>
  `);
  const doc = window.document as unknown as Document;
  const context: PageContext = { measure: measureFor(doc) };
  const elements = [...interactiveCandidates(doc.body)];

  const specs = elements.map((element, index) => ({
    element,
    elementKey: index === 0 ? 'orders.orders.approve' : 'orders.orders.hold',
  }));
  const stateFingerprint = computeStateFingerprint(ROUTE, [], '');
  const built = buildSnapshot(
    [{ stateFingerprint, routePattern: ROUTE, label: 'Orders', elements: specs }],
    [],
    context,
  );

  // The fingerprints memory holds must be the ones this page produces, or the binder would be
  // matching records against a different document than the resolver searches.
  for (const element of elements) computeFingerprint(element, context);

  return { snapshot: built.snapshot, elements, context, stateFingerprint, idByKey: built.idByKey };
}

const indexed = indexPage();
const approveId = indexed.idByKey.get('orders.orders.approve') ?? '';

/** The aliases the control plane has persisted. Keyed as the gateway keys them. */
const persisted = new Map<string, Alias>();
let escalations = 0;
let server: Server;
let origin = '';

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      resolve(body);
    });
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body);
}

/** The snapshot as the control plane would serve it now: the indexed memory plus what was learned. */
function currentSnapshot(): MemorySnapshot {
  return { ...indexed.snapshot, aliases: [...persisted.values()] };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      // Every route is authenticated, so a request that lost its token fails here rather than
      // quietly succeeding — the extension's token plumbing is part of what this suite covers.
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        json(response, 401, { code: 'unauthorized' });
        return;
      }

      const url = request.url ?? '';

      if (request.method === 'POST' && url === '/v1/resolve/escalate') {
        escalations += 1;
        const parsed = EscalateRequest.safeParse(JSON.parse(await readBody(request)));
        if (!parsed.success) {
          json(response, 400, { code: 'validation_failed' });
          return;
        }
        // The model's job, standing in: pick the approve control, confidently.
        json(response, 200, {
          elementId: approveId,
          confidence: 0.93,
          reasoning: 'the approve control commits the order',
        });
        return;
      }

      if (request.method === 'POST' && url === '/v1/memory/aliases') {
        const parsed = AliasWritebackBatch.safeParse(JSON.parse(await readBody(request)));
        if (!parsed.success) {
          json(response, 400, { code: 'validation_failed' });
          return;
        }
        let inserted = 0;
        let updated = 0;
        for (const item of parsed.data.items) {
          // Deduped on (memory version, phrase) and hit-counted on conflict — the gateway's own
          // upsert semantics, so a repeat write-back behaves here as it does in production.
          const key = `${parsed.data.memoryVersionId}::${item.phrase}`;
          const existing = persisted.get(key);
          if (existing === undefined) {
            inserted += 1;
            persisted.set(key, {
              id: `00000000-0000-4000-8000-${String(persisted.size + 500).padStart(12, '0')}`,
              tenantId: indexed.snapshot.tenantId,
              memoryVersionId: parsed.data.memoryVersionId,
              phrase: item.phrase,
              elementId: item.elementId,
              stateFingerprint: item.stateFingerprint,
              source: item.source,
              hits: 0,
              createdAt: '2026-07-29T00:00:00.000Z',
            });
          } else {
            updated += 1;
            persisted.set(key, { ...existing, hits: existing.hits + 1 });
          }
        }
        json(response, 200, { accepted: parsed.data.items.length, inserted, updated });
        return;
      }

      if (request.method === 'GET' && url.endsWith('/snapshot')) {
        json(response, 200, currentSnapshot());
        return;
      }

      json(response, 404, { code: 'not_found' });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
});

beforeEach(() => {
  persisted.clear();
  escalations = 0;
});

/** A resolver over a given snapshot, wired to the real escalation client and write-back queue. */
function resolverOver(snapshot: MemorySnapshot, queue: WritebackQueue): Resolver {
  const escalateClient = createEscalateClient({ gatewayOrigin: origin });
  return createResolver({
    snapshot,
    // No text is listed, so nothing clears the T1 bar: the phrase is genuinely unknown to this
    // memory, which is the only honest way to reach T2.
    embedder: fakeEmbedder({}),
    context: indexed.context,
    config: { queryInstruction: '' },
    source: {
      current: () => ({
        stateFingerprint: indexed.stateFingerprint,
        candidates: indexed.elements,
      }),
    },
    escalate: (request) => escalateClient.escalate(request, TOKEN),
    onAlias: (writeback) => {
      queue.enqueue(writeback);
    },
  });
}

it('an unknown phrasing costs T2 once, and is T0 forever after', async () => {
  const aliasClient = createAliasClient({ gatewayOrigin: origin });
  const queue = createWritebackQueue({
    send: (items) => aliasClient.write(indexed.snapshot.memoryVersion.id, items, TOKEN),
    // The tick is irrelevant here: this session ends with the detach flush, which is the path
    // that must not lose the last thing a tester taught it.
    intervalMs: 60_000,
  });

  // ── 1. The phrase is unknown: T0 misses, T1 misses, T2 answers ──────────────────────────
  const first = await resolverOver(indexed.snapshot, queue).resolve(UTTERANCE);

  expect(first.outcome).toBe('resolved');
  if (first.outcome !== 'resolved') throw new Error('unreachable');
  expect(first.tier).toBe('T2');
  expect(first.elementKey).toBe('orders.orders.approve');
  expect(escalations).toBe(1);

  // ── 2. What it learned survives detach ──────────────────────────────────────────────────
  expect(queue.size).toBe(1);
  await queue.close();
  expect(queue.size).toBe(0);

  const [stored] = [...persisted.values()];
  expect(stored?.source).toBe('t2_writeback');
  // Normalised the way T0 folds its alias keys. Stored in any other form it would be persisted,
  // reloaded, and then never fire — learning that looks real and does nothing.
  expect(stored?.phrase).toBe('sign off on this order');
  expect(stored?.elementId).toBe(approveId);
  expect(stored?.stateFingerprint).toBe(indexed.stateFingerprint);

  // ── 3. A fresh snapshot carries it ──────────────────────────────────────────────────────
  const memory = createMemoryClient({ gatewayOrigin: origin });
  const reloaded = await memory.load(indexed.snapshot.applicationId, TOKEN);
  if (reloaded === null) throw new Error('expected a snapshot');
  expect(reloaded.aliases).toHaveLength(1);

  // ── 4. The same phrasing is now a local hit ─────────────────────────────────────────────
  const laterQueue = createWritebackQueue({
    send: (items) => aliasClient.write(reloaded.memoryVersion.id, items, TOKEN),
    intervalMs: 60_000,
  });
  const second = await resolverOver(reloaded, laterQueue).resolve(UTTERANCE);

  expect(second.outcome).toBe('resolved');
  if (second.outcome !== 'resolved') throw new Error('unreachable');
  expect(second.tier).toBe('T0');
  expect(second.elementKey).toBe('orders.orders.approve');
  // The point of the whole phase: the second time costs no network hop and no model call.
  expect(escalations).toBe(1);
  expect(laterQueue.size).toBe(0);

  await laterQueue.close();
});

it('a phrase learned on one wording does not resolve a different one', async () => {
  const aliasClient = createAliasClient({ gatewayOrigin: origin });
  const queue = createWritebackQueue({
    send: (items) => aliasClient.write(indexed.snapshot.memoryVersion.id, items, TOKEN),
    intervalMs: 60_000,
  });

  await resolverOver(indexed.snapshot, queue).resolve(UTTERANCE);
  await queue.close();

  const memory = createMemoryClient({ gatewayOrigin: origin });
  const reloaded = await memory.load(indexed.snapshot.applicationId, TOKEN);
  if (reloaded === null) throw new Error('expected a snapshot');

  const laterQueue = createWritebackQueue({
    send: (items) => aliasClient.write(reloaded.memoryVersion.id, items, TOKEN),
    intervalMs: 60_000,
  });
  const other = await resolverOver(reloaded, laterQueue).resolve('put this one aside for now');

  // An alias is a learned mapping for the phrase that earned it, not a licence to answer anything
  // nearby at T0. A new wording escalates on its own merits.
  expect(other.tier).toBe('T2');
  expect(escalations).toBe(2);

  await laterQueue.close();
});
