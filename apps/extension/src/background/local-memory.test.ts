import type { MemorySnapshot } from 'protocol';
import { describe, expect, it } from 'vitest';

import {
  LOCAL_MEMORY_KEY,
  canonicalOrigin,
  createLocalMemoryStore,
  parseLocalMemory,
  snapshotCounts,
  type LocalStorageArea,
} from './local-memory.js';

function snapshot(overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    applicationId: '22222222-2222-4222-8222-222222222222',
    memoryVersion: {
      id: '33333333-3333-4333-8333-333333333333',
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
    ...overrides,
  };
}

function area(): LocalStorageArea & { readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (key) => Promise.resolve(values.has(key) ? { [key]: values.get(key) } : {}),
    set: (items) => {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

describe('canonicalOrigin', () => {
  it('drops the path so a dump of /login matches a tab on /orders', () => {
    expect(canonicalOrigin('https://staging.alaanpay.com/login')).toBe(
      'https://staging.alaanpay.com',
    );
  });

  it('accepts a hostname and assumes https', () => {
    expect(canonicalOrigin('staging.alaanpay.com')).toBe('https://staging.alaanpay.com');
  });

  it('keeps an explicit port', () => {
    expect(canonicalOrigin('http://127.0.0.1:3000/foo')).toBe('http://127.0.0.1:3000');
  });

  it('refuses anything that is not http(s)', () => {
    expect(canonicalOrigin('file:///tmp/dump.json')).toBeNull();
    expect(canonicalOrigin('javascript:alert(1)')).toBeNull();
    expect(canonicalOrigin('')).toBeNull();
  });
});

describe('parseLocalMemory', () => {
  it('accepts the envelope a developer wraps around a dump', () => {
    const result = parseLocalMemory({
      origin: 'https://orders.example/home',
      snapshot: snapshot(),
    });

    expect(result).toEqual({
      ok: true,
      envelope: { origin: 'https://orders.example', snapshot: snapshot() },
    });
  });

  it('accepts a bare snapshot when an origin is supplied beside it', () => {
    const result = parseLocalMemory(snapshot(), 'https://orders.example');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.origin).toBe('https://orders.example');
  });

  it('lets a typed origin override a stale origin in the file', () => {
    const result = parseLocalMemory(
      { origin: 'https://old.example', snapshot: snapshot() },
      'https://new.example',
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.origin).toBe('https://new.example');
  });

  it('refuses a snapshot with no origin', () => {
    const result = parseLocalMemory(snapshot());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/origin is required/);
  });

  it('refuses a payload that is not a MemorySnapshot', () => {
    const result = parseLocalMemory({ screens: 1 }, 'https://orders.example');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/MemorySnapshot/);
  });
});

describe('the local memory store', () => {
  it('round-trips a valid envelope and ignores a corrupt one', async () => {
    const storage = area();
    const store = createLocalMemoryStore(storage);
    const envelope = { origin: 'https://orders.example', snapshot: snapshot() };

    await store.write(envelope);
    expect(storage.values.has(LOCAL_MEMORY_KEY)).toBe(true);
    expect(await store.read()).toEqual(envelope);

    await storage.set({ [LOCAL_MEMORY_KEY]: { origin: 'https://orders.example' } });
    expect(await store.read()).toBeNull();
  });

  it('counts screens and elements without reading their labels', () => {
    expect(snapshotCounts(snapshot())).toEqual({ screens: 0, elements: 0 });
  });
});
