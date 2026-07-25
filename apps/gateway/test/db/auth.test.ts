import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NEIGHBOUR, SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * Authentication and authorisation, end to end.
 *
 * Every token here is a real signed JWT from a real HTTP issuer, verified by the real
 * `src/auth` code against a real JWKS document. Nothing is injected past.
 */

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness({
    routes: (app) => {
      // Minimal routes that exist only to exercise the pipeline. Product endpoints belong to
      // the phases that own them; these assert the infrastructure, and nothing more.
      app.get('/test/whoami', (request) => ({
        tenantId: request.principal?.tenantId,
        role: request.principal?.role,
        email: request.principal?.email,
      }));
      app.get('/test/public', { config: { public: true } }, () => ({ ok: true }));
      app.get('/test/seed-execute', { config: { permission: 'seed:execute' } }, () => ({
        ok: true,
      }));
      app.get('/test/memory-read', { config: { permission: 'memory:read' } }, () => ({ ok: true }));
      app.get('/test/admin', { config: { permission: 'admin:manage' } }, () => ({ ok: true }));
    },
  });
});

afterAll(async () => {
  await harness.close();
});

async function get(path: string, token?: string) {
  return harness.app.inject({
    method: 'GET',
    url: path,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

describe('a valid token', () => {
  it('authenticates and resolves the principal from the database', async () => {
    const token = await harness.issuer.sign({ email: SEED.leadEmail });
    const response = await get('/test/whoami', token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tenantId: SEED.tenantId,
      role: 'lead',
      email: SEED.leadEmail,
    });
  });

  it('resolves a different user to a different role in the same tenant', async () => {
    const token = await harness.issuer.sign({ email: SEED.testerEmail });
    const response = await get('/test/whoami', token);

    expect(response.json()).toMatchObject({ tenantId: SEED.tenantId, role: 'tester' });
  });

  it('resolves the neighbouring tenant to its own tenant, not ours', async () => {
    // The two seed tenants deliberately share a local part in their addresses. If the principal
    // lookup ever compared on anything looser than the full address, this would cross tenants.
    const token = await harness.issuer.sign({ email: NEIGHBOUR.ownerEmail });
    const response = await get('/test/whoami', token);

    expect(response.json()).toMatchObject({ tenantId: NEIGHBOUR.tenantId, role: 'owner' });
  });
});

describe('a token that must be refused', () => {
  it.each([
    ['no Authorization header', undefined],
    ['an empty bearer credential', ''],
  ])('rejects %s', async (_name, token) => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/test/whoami',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a non-Bearer scheme', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/test/whoami',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a token from another issuer', async () => {
    const token = await harness.issuer.sign({
      email: SEED.leadEmail,
      issuer: 'https://someone-elses-idp.example',
    });
    expect((await get('/test/whoami', token)).statusCode).toBe(401);
  });

  it('rejects a token minted for another audience', async () => {
    // The check that stops one compromised service in an estate from impersonating a user
    // against all the others.
    const token = await harness.issuer.sign({
      email: SEED.leadEmail,
      audience: 'some-other-service',
    });
    expect((await get('/test/whoami', token)).statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = await harness.issuer.sign({ email: SEED.leadEmail, expiresInSeconds: -3600 });
    expect((await get('/test/whoami', token)).statusCode).toBe(401);
  });

  it('still accepts a token just inside the configured clock tolerance', async () => {
    // The other side of the same setting. Two machines never agree to the second, and a gateway
    // that rejected a token one second past expiry would fail requests for no good reason.
    const token = await harness.issuer.sign({ email: SEED.leadEmail, expiresInSeconds: -5 });
    expect(harness.config.OIDC_CLOCK_TOLERANCE_SECONDS).toBeGreaterThan(5);
    expect((await get('/test/whoami', token)).statusCode).toBe(200);
  });

  it('rejects a token with no expiry at all', async () => {
    // `jwtVerify` accepts a token without `exp`. A credential that never expires is not one we
    // are willing to hold, so the verifier rejects it explicitly.
    const token = await harness.issuer.sign({ email: SEED.leadEmail, withoutExpiry: true });
    expect((await get('/test/whoami', token)).statusCode).toBe(401);
  });

  it('rejects a token signed by a key the issuer does not publish', async () => {
    const token = await harness.issuer.signWithUnpublishedKey({ email: SEED.leadEmail });
    expect((await get('/test/whoami', token)).statusCode).toBe(401);
  });

  it('rejects a token whose payload has been tampered with', async () => {
    const token = await harness.issuer.sign({ email: SEED.testerEmail });
    const [header = '', , signature = ''] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ email: SEED.leadEmail, sub: SEED.leadEmail, exp: 9_999_999_999 }),
    ).toString('base64url');

    const response = await get('/test/whoami', `${header}.${forgedPayload}.${signature}`);
    expect(response.statusCode).toBe(401);
  });

  it('rejects a well-formed token for somebody no tenant knows', async () => {
    const token = await harness.issuer.sign({ email: 'nobody@nowhere.example' });
    expect((await get('/test/whoami', token)).statusCode).toBe(401);
  });

  it('never explains which check failed', async () => {
    // Telling an unauthenticated caller precisely why their token was refused helps them iterate
    // towards one that passes. The reason belongs in the log line, which carries the trace id.
    // Well beyond OIDC_CLOCK_TOLERANCE_SECONDS. A token ten seconds past expiry is still
    // accepted, and correctly so — that tolerance exists because two machines never agree to
    // the second.
    const expired = await harness.issuer.sign({ email: SEED.leadEmail, expiresInSeconds: -3600 });
    const wrongAudience = await harness.issuer.sign({
      email: SEED.leadEmail,
      audience: 'elsewhere',
    });

    const first = (await get('/test/whoami', expired)).json<unknown>();
    const second = (await get('/test/whoami', wrongAudience)).json<unknown>();

    expect(first).toEqual({
      code: 'unauthorized',
      message: 'authentication required',
      retryable: false,
    });
    expect(second).toEqual(first);
  });
});

describe('public routes', () => {
  it('serve without a token', async () => {
    const response = await get('/test/public');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('are opt-out, so a route that says nothing is protected', async () => {
    // The failure mode of an opt-in scheme is a public endpoint nobody noticed. `/test/whoami`
    // declares no config at all and is still refused without a token.
    expect((await get('/test/whoami')).statusCode).toBe(401);
  });
});

describe('RBAC', () => {
  it('allows a lead to execute a seed', async () => {
    const token = await harness.issuer.sign({ email: SEED.leadEmail });
    expect((await get('/test/seed-execute', token)).statusCode).toBe(200);
  });

  it('refuses a tester the same action, and names the role they would need', async () => {
    const token = await harness.issuer.sign({ email: SEED.testerEmail });
    const response = await get('/test/seed-execute', token);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'forbidden',
      retryable: false,
      requiredRole: 'lead',
    });
  });

  it('allows a tester what their role does hold', async () => {
    const token = await harness.issuer.sign({ email: SEED.testerEmail });
    expect((await get('/test/memory-read', token)).statusCode).toBe(200);
  });

  it('refuses even a lead an owner-only action', async () => {
    const token = await harness.issuer.sign({ email: SEED.leadEmail });
    const response = await get('/test/admin', token);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ requiredRole: 'owner' });
  });

  it('authenticates before it authorises', async () => {
    // An unauthenticated request to a permissioned route is 401, not 403: there is no principal
    // to authorise, and reporting it as a permission failure would suggest logging in as
    // somebody else might help.
    expect((await get('/test/admin')).statusCode).toBe(401);
  });
});

describe('JWKS caching and rotation', () => {
  it('does not fetch the key set again for every request', async () => {
    const before = harness.issuer.jwksRequestCount;

    for (let i = 0; i < 5; i += 1) {
      const token = await harness.issuer.sign({ email: SEED.leadEmail });
      expect((await get('/test/whoami', token)).statusCode).toBe(200);
    }

    // Putting the identity provider in the hot path of every authenticated call is both slow
    // and a way for an IdP hiccup to take the gateway down with it.
    expect(harness.issuer.jwksRequestCount).toBe(before);
  });

  it('refetches when a token arrives signed by a key it has not seen', async () => {
    const before = harness.issuer.jwksRequestCount;

    await harness.issuer.rotate();
    const token = await harness.issuer.sign({ email: SEED.leadEmail });

    // A routine key rotation must not lock every user out until someone redeploys.
    expect((await get('/test/whoami', token)).statusCode).toBe(200);
    expect(harness.issuer.jwksRequestCount).toBeGreaterThan(before);
  });

  it('still accepts tokens signed by the rotated-in key without refetching again', async () => {
    const after = harness.issuer.jwksRequestCount;
    const token = await harness.issuer.sign({ email: SEED.leadEmail });

    expect((await get('/test/whoami', token)).statusCode).toBe(200);
    expect(harness.issuer.jwksRequestCount).toBe(after);
  });
});
