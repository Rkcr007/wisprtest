import type { ExtensionToken, MemorySnapshot } from 'protocol';
import { describe, expect, it, vi } from 'vitest';

import type { HudUpdate } from '../messaging.js';
import type { AliasClient } from './alias-client.js';
import {
  alarmNameFor,
  createAttachController,
  type AlarmScheduler,
  type PortLike,
} from './attach.js';
import type { EscalateClient } from './escalate-client.js';
import type { MemoryClient } from './memory-client.js';
import { UnauthenticatedError } from './token-client.js';
import type { TokenStore } from './token-store.js';

/**
 * The attach state machine.
 *
 * Two properties here are worth more than the rest: that a failed attach ends in `failed` rather
 * than an eternal `attaching`, and that the token never reaches the content script. The first is
 * what a tester sees when the gateway is down; the second is what an XSS in the application under
 * test cannot steal.
 */

const TAB = 7;

function token(overrides: Partial<ExtensionToken> = {}): ExtensionToken {
  return {
    token: 'a.scoped.token',
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    tenantId: '11111111-1111-4111-8111-111111111111',
    applicationId: '22222222-2222-4222-8222-222222222222',
    scopes: ['memory:read'],
    ...overrides,
  };
}

/** A port with the shape Chrome gives, driven by the test. */
function fakePort(tabId: number | null = TAB): {
  port: PortLike;
  sent: HudUpdate[];
  emit: (message: unknown) => void;
  disconnect: () => void;
  disconnected: boolean;
} {
  const sent: HudUpdate[] = [];
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  let disconnected = false;

  const port: PortLike = {
    name: 'wispr:hud',
    sender: tabId === null ? {} : { tab: { id: tabId } },
    postMessage: (message: unknown) => {
      sent.push(message as HudUpdate);
    },
    onMessage: {
      addListener: (listener) => messageListeners.push(listener),
    },
    onDisconnect: {
      addListener: (listener) => disconnectListeners.push(listener),
    },
    disconnect: () => {
      disconnected = true;
    },
  };

  return {
    port,
    sent,
    emit: (message) => {
      for (const listener of messageListeners) listener(message);
    },
    disconnect: () => {
      for (const listener of disconnectListeners) listener();
    },
    get disconnected() {
      return disconnected;
    },
  };
}

function memoryStore(): TokenStore & { readonly values: Map<string, ExtensionToken> } {
  const values = new Map<string, ExtensionToken>();
  return {
    values,
    read: (origin) => Promise.resolve(values.get(origin) ?? null),
    write: (origin, value) => {
      values.set(origin, value);
      return Promise.resolve();
    },
    clear: (origin) => {
      values.delete(origin);
      return Promise.resolve();
    },
  };
}

function alarms(): AlarmScheduler & { readonly created: { name: string; when: number }[] } {
  const created: { name: string; when: number }[] = [];
  return {
    created,
    create: (name, info) => {
      created.push({ name, when: info.when });
    },
    clear: () => Promise.resolve(true),
  };
}

describe('connecting', () => {
  it('reports detached before the tester has attached', () => {
    const connection = fakePort();
    const controller = createAttachController({
      tokens: { fetchToken: vi.fn() },
      store: memoryStore(),
      alarms: alarms(),
    });

    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });

    expect(connection.sent.at(-1)?.attach).toBe('detached');
    expect(connection.sent.at(-1)?.token).toBe('absent');
  });

  it('hangs up on a port that is not a tab', () => {
    // `null`, not `undefined`: passing `undefined` would take the default and give it a tab.
    const connection = fakePort(null);
    const controller = createAttachController({
      tokens: { fetchToken: vi.fn() },
      store: memoryStore(),
      alarms: alarms(),
    });

    controller.connect(connection.port);

    // Nothing else in this extension connects. A port with no tab is either a bug or something
    // we should not be talking to.
    expect(connection.disconnected).toBe(true);
  });

  it('ignores a message that is not one of ours', () => {
    const onError = vi.fn();
    const connection = fakePort();
    const controller = createAttachController({
      tokens: { fetchToken: vi.fn() },
      store: memoryStore(),
      alarms: alarms(),
      onError,
    });

    controller.connect(connection.port);
    connection.emit({ kind: 'exfiltrate', target: 'everything' });

    // The content script shares a page with the application under test. Anything arriving here
    // is parsed before it is acted on.
    expect(onError).toHaveBeenCalled();
    expect(controller.stateOf(TAB)).toBe('detached');
  });
});

describe('attaching', () => {
  it('goes detached → attaching → attached, and holds a token at the end', async () => {
    const connection = fakePort();
    const store = memoryStore();
    const controller = createAttachController({
      tokens: { fetchToken: () => Promise.resolve(token()) },
      store,
      alarms: alarms(),
    });

    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(TAB);

    expect(connection.sent.map((update) => update.attach)).toEqual([
      'detached',
      'attaching',
      'attached',
    ]);
    expect(controller.stateOf(TAB)).toBe('attached');
    expect(store.values.get('https://orders.example')).toBeDefined();
  });

  it('never sends the token to the content script', async () => {
    const connection = fakePort();
    const controller = createAttachController({
      tokens: { fetchToken: () => Promise.resolve(token({ token: 'super-secret-bearer' })) },
      store: memoryStore(),
      alarms: alarms(),
    });

    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(TAB);

    // This is the assertion that makes the whole storage design worth having: an XSS in the
    // application under test can talk to the content script, and there is nothing there to steal.
    const serialised = JSON.stringify(connection.sent);
    expect(serialised).not.toContain('super-secret-bearer');
    // What it does get is the state, and the identifiers it needs to render.
    expect(connection.sent.at(-1)?.token).toBe('valid');
    expect(connection.sent.at(-1)?.tenantId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('reuses a cached token rather than minting one per tab', async () => {
    const fetchToken = vi.fn(() => Promise.resolve(token()));
    const store = memoryStore();
    const controller = createAttachController({ tokens: { fetchToken }, store, alarms: alarms() });

    const first = fakePort(1);
    controller.connect(first.port);
    first.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(1);

    const second = fakePort(2);
    controller.connect(second.port);
    second.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(2);

    // Two tabs on one application are one application.
    expect(fetchToken).toHaveBeenCalledOnce();
    expect(second.sent.at(-1)?.attach).toBe('attached');
  });

  it('reports an application of null without calling it a failure', async () => {
    const connection = fakePort();
    const controller = createAttachController({
      tokens: { fetchToken: () => Promise.resolve(token({ applicationId: null })) },
      store: memoryStore(),
      alarms: alarms(),
    });

    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://unindexed.example' });
    await controller.toggle(TAB);

    // Browsing an application nobody has indexed is a normal thing for a tester to do. It is not
    // an error, and showing one would train them to ignore errors.
    expect(connection.sent.at(-1)?.attach).toBe('attached');
    expect(connection.sent.at(-1)?.applicationId).toBeNull();
    expect(connection.sent.at(-1)?.failure).toBeNull();
  });

  it('schedules a refresh before the token expires', async () => {
    const scheduler = alarms();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const controller = createAttachController({
      tokens: { fetchToken: () => Promise.resolve(token({ expiresAt })) },
      store: memoryStore(),
      alarms: scheduler,
      refreshMarginMs: 300_000,
    });

    const connection = fakePort();
    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(TAB);

    // An alarm, not a timer: Chrome terminates an idle service worker in about 30 seconds and a
    // `setTimeout` dies with it.
    expect(scheduler.created).toHaveLength(1);
    expect(scheduler.created[0]?.name).toBe(alarmNameFor(TAB));
    expect(scheduler.created[0]?.when).toBe(Date.parse(expiresAt) - 300_000);
  });
});

describe('failing', () => {
  it('ends in failed with a reason the HUD can phrase', async () => {
    const connection = fakePort();
    const controller = createAttachController({
      tokens: {
        fetchToken: () => Promise.reject(new UnauthenticatedError()),
      },
      store: memoryStore(),
      alarms: alarms(),
    });

    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(TAB);

    const last = connection.sent.at(-1);
    expect(last?.attach).toBe('failed');
    expect(last?.failure).toBe('unauthenticated');
    expect(last?.token).toBe('failed');
    // Not a permanent "attaching…", which is what a machine with no failure state shows.
    expect(controller.stateOf(TAB)).toBe('failed');
  });

  it('drops the cached token rather than reusing it', async () => {
    const store = memoryStore();
    store.values.set(
      'https://orders.example',
      token({ expiresAt: new Date(Date.now() + 1_000).toISOString() }),
    );

    const controller = createAttachController({
      tokens: { fetchToken: () => Promise.reject(new UnauthenticatedError()) },
      store,
      alarms: alarms(),
      refreshMarginMs: 60_000,
    });

    const connection = fakePort();
    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(TAB);

    // Fail closed. A credential that "usually works" is how an expired session becomes an
    // unexplained 401 in the middle of a command.
    expect(store.values.has('https://orders.example')).toBe(false);
  });

  it('lets the tester try again', async () => {
    const fetchToken = vi
      .fn<() => Promise<ExtensionToken>>()
      .mockRejectedValueOnce(new UnauthenticatedError())
      .mockResolvedValueOnce(token());

    const controller = createAttachController({
      tokens: { fetchToken },
      store: memoryStore(),
      alarms: alarms(),
    });

    const connection = fakePort();
    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });

    await controller.toggle(TAB);
    expect(controller.stateOf(TAB)).toBe('failed');

    await controller.toggle(TAB);
    expect(controller.stateOf(TAB)).toBe('attached');
  });
});

describe('detaching', () => {
  it('drops the token and the refresh alarm', async () => {
    const scheduler = alarms();
    const clear = vi.spyOn(scheduler, 'clear');
    const controller = createAttachController({
      tokens: { fetchToken: () => Promise.resolve(token()) },
      store: memoryStore(),
      alarms: scheduler,
    });

    const connection = fakePort();
    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(TAB);
    await controller.toggle(TAB);

    expect(controller.stateOf(TAB)).toBe('detached');
    expect(connection.sent.at(-1)?.tenantId).toBeNull();
    expect(clear).toHaveBeenCalledWith(alarmNameFor(TAB));
  });

  it('forgets the session when the tab goes away', async () => {
    const controller = createAttachController({
      tokens: { fetchToken: () => Promise.resolve(token()) },
      store: memoryStore(),
      alarms: alarms(),
    });

    const connection = fakePort();
    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(TAB);

    connection.disconnect();

    // The port drops when the tab navigates or closes. Holding the session would leak one record
    // per page a tester ever visits.
    expect(controller.stateOf(TAB)).toBe('detached');
  });
});

describe('refreshing', () => {
  it('mints a new token when the alarm fires', async () => {
    const fetchToken = vi
      .fn<() => Promise<ExtensionToken>>()
      .mockResolvedValueOnce(token({ token: 'first' }))
      .mockResolvedValueOnce(token({ token: 'second' }));

    const store = memoryStore();
    const controller = createAttachController({ tokens: { fetchToken }, store, alarms: alarms() });

    const connection = fakePort();
    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(TAB);

    await controller.onAlarm(alarmNameFor(TAB));

    // The cache is cleared first, or `acquire` would hand back the very token the refresh exists
    // to replace — it is still inside its usable window, which is the point of refreshing early.
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(store.values.get('https://orders.example')?.token).toBe('second');
    expect(controller.stateOf(TAB)).toBe('attached');
  });

  it('ignores an alarm for a tab that is no longer attached', async () => {
    const fetchToken = vi.fn(() => Promise.resolve(token()));
    const controller = createAttachController({
      tokens: { fetchToken },
      store: memoryStore(),
      alarms: alarms(),
    });

    await controller.onAlarm(alarmNameFor(99));

    expect(fetchToken).not.toHaveBeenCalled();
  });
});

describe('T2 escalation and the write-back queue', () => {
  const MEMORY_VERSION = '33333333-3333-4333-8333-333333333333';
  const ELEMENT = '44444444-4444-4444-8444-444444444444';
  const STATE = 'a'.repeat(64);

  /** A snapshot with nothing in it: the queue only needs the memory version it is scoped to. */
  function snapshot(): MemorySnapshot {
    return {
      tenantId: '11111111-1111-4111-8111-111111111111',
      applicationId: '22222222-2222-4222-8222-222222222222',
      memoryVersion: {
        id: MEMORY_VERSION,
        tenantId: '11111111-1111-4111-8111-111111111111',
        applicationId: '22222222-2222-4222-8222-222222222222',
        version: 1,
        status: 'active',
        createdAt: '2026-07-29T00:00:00.000Z',
        approvedBy: null,
        failureReason: null,
      },
      screens: [],
      elements: [],
      navEdges: [],
      aliases: [],
      generatedAt: '2026-07-29T00:00:00.000Z',
    };
  }

  function memoryClient(): MemoryClient {
    return {
      load: () => Promise.resolve(snapshot()),
      get: () => snapshot(),
      invalidate: () => undefined,
    };
  }

  const escalateRequest = {
    utterance: 'sign off on this order',
    stateFingerprint: STATE,
    candidates: [{ elementId: ELEMENT, elementKey: 'orders.orders.approve', label: 'Approve' }],
  };

  const writeback = {
    phrase: 'sign off on this order',
    elementId: ELEMENT,
    stateFingerprint: STATE,
    source: 't2_writeback',
  };

  /** An attached tab with a snapshot loaded, which is what opens the write-back queue. */
  async function attached(options: {
    escalation?: EscalateClient;
    aliases?: AliasClient;
  }): Promise<ReturnType<typeof fakePort>> {
    const connection = fakePort();
    const controller = createAttachController({
      tokens: { fetchToken: () => Promise.resolve(token()) },
      store: memoryStore(),
      alarms: alarms(),
      memory: memoryClient(),
      writebackIntervalMs: 60_000,
      ...options,
    });

    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(TAB);
    // The snapshot load is deliberately off the attach path; let it land.
    await Promise.resolve();
    await Promise.resolve();

    return connection;
  }

  it('runs an escalation with the tab token and answers over the port', async () => {
    const escalate = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        response: { elementId: ELEMENT, confidence: 0.9, reasoning: 'the approve control' },
      }),
    );
    const connection = await attached({ escalation: { escalate } });

    connection.emit({ kind: 'escalate', requestId: 'req-1', request: escalateRequest });
    await Promise.resolve();
    await Promise.resolve();

    // The token is attached here and never sent to the content script — the same rule the snapshot
    // fetch follows, for the same reason.
    expect(escalate).toHaveBeenCalledWith(escalateRequest, 'a.scoped.token');
    const reply = connection.sent.at(-1) as unknown as {
      kind: string;
      requestId: string;
      ok: boolean;
    };
    expect(reply.kind).toBe('escalate_result');
    expect(reply.requestId).toBe('req-1');
    expect(reply.ok).toBe(true);
  });

  it('answers unavailable when there is no session to escalate through', async () => {
    const connection = fakePort();
    const controller = createAttachController({
      tokens: { fetchToken: () => Promise.resolve(token()) },
      store: memoryStore(),
      alarms: alarms(),
      escalation: { escalate: vi.fn() },
    });

    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });
    connection.emit({ kind: 'escalate', requestId: 'req-1', request: escalateRequest });
    await Promise.resolve();

    // A detached tab still gets an answer: the content script falls back to its T1 candidates
    // rather than waiting on a reply that is never coming.
    const reply = connection.sent.at(-1) as unknown as { ok: boolean; reason: string };
    expect(reply.ok).toBe(false);
    expect(reply.reason).toBe('unavailable');
  });

  it('never sends a malformed escalation to the gateway', async () => {
    const escalate = vi.fn();
    const connection = await attached({ escalation: { escalate } });

    connection.emit({ kind: 'escalate', requestId: 'req-1', request: { utterance: 42 } });
    await Promise.resolve();

    // This arrives from a page the extension does not control. A request that is not the contract's
    // does not reach the model, and does not spend a tenant's budget.
    expect(escalate).not.toHaveBeenCalled();
  });

  it('holds learned aliases and flushes them on detach', async () => {
    const write = vi.fn(() => Promise.resolve({ accepted: 1, inserted: 1, updated: 0 }));
    const connection = await attached({ aliases: { write } });

    connection.emit({ kind: 'alias_writeback', writeback });
    // Nothing goes out per resolution: the queue is what talks to the control plane.
    expect(write).not.toHaveBeenCalled();

    connection.emit({ kind: 'detach' });
    await Promise.resolve();
    await Promise.resolve();

    // The phase's "and on detach". The batch is scoped to the memory version it was learned on,
    // and it still carries the token, which detach has by then cleared off the session.
    expect(write).toHaveBeenCalledWith(MEMORY_VERSION, [writeback], 'a.scoped.token');
  });

  it('flushes when the tab goes away without detaching', async () => {
    const write = vi.fn(() => Promise.resolve({ accepted: 1, inserted: 1, updated: 0 }));
    const connection = await attached({ aliases: { write } });

    connection.emit({ kind: 'alias_writeback', writeback });
    connection.disconnect();
    await Promise.resolve();
    await Promise.resolve();

    // A tester who closes the tab has taught the system just as much as one who clicks detach.
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('refuses a write-back that is not the contract shape', async () => {
    const write = vi.fn(() => Promise.resolve({ accepted: 0, inserted: 0, updated: 0 }));
    const onError = vi.fn();
    const connection = fakePort();
    const controller = createAttachController({
      tokens: { fetchToken: () => Promise.resolve(token()) },
      store: memoryStore(),
      alarms: alarms(),
      memory: memoryClient(),
      aliases: { write },
      writebackIntervalMs: 60_000,
      onError,
    });
    controller.connect(connection.port);
    connection.emit({ kind: 'hello', origin: 'https://orders.example' });
    await controller.toggle(TAB);
    await Promise.resolve();
    await Promise.resolve();

    connection.emit({ kind: 'alias_writeback', writeback: { phrase: '', elementId: 'nope' } });
    connection.emit({ kind: 'detach' });
    await Promise.resolve();
    await Promise.resolve();

    // A stranger's phrase must not end up in a tenant's vocabulary.
    expect(onError).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
