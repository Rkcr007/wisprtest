import type { MemorySnapshot } from 'protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSnapshot, type ScreenSpec } from '../resolver/testing.js';
import {
  createMemoryClient,
  MalformedSnapshotError,
  SnapshotUnauthorizedError,
  SnapshotUnreachableError,
} from './memory-client.js';

const ORIGIN = 'https://gateway.wispr.test';
const APP = '00000000-0000-4000-8000-000000000001';

function snapshotPayload(): MemorySnapshot {
  document.body.innerHTML = `<main><section aria-label="Orders"><button data-testid="approve">Approve order</button></section></main>`;
  const button = document.body.querySelector('button') as Element;
  const screens: ScreenSpec[] = [
    {
      stateFingerprint: 'a'.repeat(64),
      routePattern: '/orders',
      label: 'Orders',
      elements: [{ element: button, elementKey: 'orders.orders.approve' }],
    },
  ];
  return buildSnapshot(screens).snapshot;
}

function jsonResponse(status: number, body: unknown): Response {
  const response = {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
    clone: () => jsonResponse(status, body),
  };
  return response as unknown as Response;
}

describe('MemoryClient.load', () => {
  let snapshot: MemorySnapshot;

  beforeEach(() => {
    snapshot = snapshotPayload();
  });

  it('fetches, validates and holds a snapshot, sending the bearer token', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(200, snapshot)),
    );
    const client = createMemoryClient({ gatewayOrigin: ORIGIN, fetch: fetchImpl });

    const loaded = await client.load(APP, 'tok-123');

    expect(loaded?.memoryVersion.id).toBe(snapshot.memoryVersion.id);
    expect(client.get(APP)?.memoryVersion.id).toBe(snapshot.memoryVersion.id);

    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe(`${ORIGIN}/v1/memory/${APP}/snapshot`);
    expect(call?.[1]?.headers).toMatchObject({ authorization: 'Bearer tok-123' });
  });

  it('returns null for a still-indexing application, and holds nothing', async () => {
    const body = { code: 'memory_snapshot_unavailable', message: 'not ready', retryable: false };
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(503, body)));
    const client = createMemoryClient({ gatewayOrigin: ORIGIN, fetch: fetchImpl });

    expect(await client.load(APP, 'tok')).toBeNull();
    expect(client.get(APP)).toBeNull();
    // A definitive "not indexed" is not retried.
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws on an auth failure, without retrying', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(401, { code: 'unauthorized' })));
    const client = createMemoryClient({ gatewayOrigin: ORIGIN, fetch: fetchImpl });

    await expect(client.load(APP, 'tok')).rejects.toBeInstanceOf(SnapshotUnauthorizedError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries a 5xx with backoff, then succeeds', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { code: 'internal' }))
      .mockResolvedValueOnce(jsonResponse(200, snapshot));
    const client = createMemoryClient({
      gatewayOrigin: ORIGIN,
      fetch: fetchImpl,
      sleep,
    });

    const loaded = await client.load(APP, 'tok');
    expect(loaded?.memoryVersion.id).toBe(snapshot.memoryVersion.id);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('gives up with a typed error after exhausting retries', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(503, { code: 'internal' })));
    const client = createMemoryClient({
      gatewayOrigin: ORIGIN,
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
      maxAttempts: 2,
    });

    await expect(client.load(APP, 'tok')).rejects.toBeInstanceOf(SnapshotUnreachableError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a payload that is not a MemorySnapshot', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, { not: 'a snapshot' })));
    const client = createMemoryClient({ gatewayOrigin: ORIGIN, fetch: fetchImpl });

    await expect(client.load(APP, 'tok')).rejects.toBeInstanceOf(MalformedSnapshotError);
  });

  it('forgets a held snapshot on invalidate — the version-mismatch path', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, snapshot)));
    const client = createMemoryClient({ gatewayOrigin: ORIGIN, fetch: fetchImpl });

    await client.load(APP, 'tok');
    expect(client.get(APP)).not.toBeNull();
    client.invalidate(APP);
    expect(client.get(APP)).toBeNull();
  });
});
