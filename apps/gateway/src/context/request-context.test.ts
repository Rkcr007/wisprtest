import { describe, expect, it } from 'vitest';

import {
  attachPrincipal,
  currentContext,
  currentTenantId,
  runWithContext,
} from './request-context.js';

/**
 * The ambient request context.
 *
 * The properties that matter are about isolation and propagation — a context that leaked across
 * concurrent requests would attach one tenant's data to another's audit trail, and one that
 * failed to propagate would leave a request unable to reach the database it had just
 * authenticated for.
 */

const base = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: null,
  role: null,
  sessionId: null,
  traceId: 'trace',
  requestId: 'request',
} as const;

describe('propagation', () => {
  it('is visible to the whole async subtree, not just the synchronous part', async () => {
    // The property the logger's mixin and the database layer both depend on: a line emitted
    // deep inside a repository, several awaits down, still sees the tenant.
    const seen = await runWithContext(base, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentTenantId();
    });

    expect(seen).toBe(base.tenantId);
  });

  it('is undefined outside a request', () => {
    // Boot, and background jobs. Not an error — the database layer is what turns "no tenant"
    // into a failure, and it does so naming the operation it was asked to perform.
    expect(currentContext()).toBeUndefined();
    expect(currentTenantId()).toBeUndefined();
  });
});

describe('isolation between concurrent requests', () => {
  it('keeps two overlapping contexts apart', async () => {
    // The failure this guards against is the worst kind: one tenant's request reading, writing
    // or logging under another's identity because the contexts interleaved.
    const [first, second] = await Promise.all([
      runWithContext({ ...base, tenantId: 'tenant-a', requestId: 'a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentTenantId();
      }),
      runWithContext({ ...base, tenantId: 'tenant-b', requestId: 'b' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return currentTenantId();
      }),
    ]);

    expect(first).toBe('tenant-a');
    expect(second).toBe('tenant-b');
  });

  it('does not let a principal attached in one context reach another', async () => {
    const [a, b] = await Promise.all([
      runWithContext({ ...base, tenantId: 'anonymous-a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        attachPrincipal({
          tenantId: 'tenant-a',
          userId: 'user-a',
          role: 'lead',
          sessionId: null,
        });
        return currentContext();
      }),
      runWithContext({ ...base, tenantId: 'anonymous-b' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return currentContext();
      }),
    ]);

    expect(a?.tenantId).toBe('tenant-a');
    expect(b?.tenantId).toBe('anonymous-b');
    expect(b?.userId).toBeNull();
  });

  it('does not mutate the caller’s object', async () => {
    // `runWithContext` copies. Otherwise `attachPrincipal` would write into whatever object the
    // hook happened to construct, and a shared constant would accumulate tenants.
    const original = { ...base };

    await runWithContext(original, async () => {
      attachPrincipal({ tenantId: 't', userId: 'u', role: 'owner', sessionId: null });
      await Promise.resolve();
    });

    expect(original.userId).toBeNull();
    expect(original.tenantId).toBe(base.tenantId);
  });
});

describe('attachPrincipal', () => {
  it('fills in the context the request already has', async () => {
    const context = await runWithContext(base, async () => {
      attachPrincipal({
        tenantId: 'tenant-x',
        userId: 'user-x',
        role: 'tester',
        sessionId: 'session-x',
      });
      await Promise.resolve();
      return currentContext();
    });

    expect(context).toMatchObject({
      tenantId: 'tenant-x',
      userId: 'user-x',
      role: 'tester',
      sessionId: 'session-x',
      // Untouched: correlation survives authentication.
      traceId: 'trace',
      requestId: 'request',
    });
  });

  it('refuses a second principal on the same request', async () => {
    // Two principals on one request means something has gone badly wrong upstream. Taking the
    // second silently would make the audit trail a work of fiction.
    await runWithContext(base, async () => {
      attachPrincipal({ tenantId: 't1', userId: 'u1', role: 'lead', sessionId: null });
      expect(() => {
        attachPrincipal({ tenantId: 't2', userId: 'u2', role: 'owner', sessionId: null });
      }).toThrow(/already has an authenticated principal/);
      await Promise.resolve();
    });
  });

  it('throws outside a request rather than silently doing nothing', () => {
    // Silently succeeding would leave a request believing it authenticated while reading as
    // nobody — zero rows, no error, and a very long afternoon.
    expect(() => {
      attachPrincipal({ tenantId: 't', userId: 'u', role: 'lead', sessionId: null });
    }).toThrow(/outside a request context/);
  });
});
