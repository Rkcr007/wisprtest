import type { ExtensionToken } from 'protocol';
import { describe, expect, it, vi } from 'vitest';

import type { HudUpdate } from '../messaging.js';
import {
  alarmNameFor,
  createAttachController,
  type AlarmScheduler,
  type PortLike,
} from './attach.js';
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
