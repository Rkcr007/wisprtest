import { randomUUID } from 'node:crypto';

import { ExtensionToken } from 'protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NEIGHBOUR, SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * Registering an application and minting an extension token, against the real stack.
 *
 * Two properties matter more than the rest:
 *
 * 1. **A tester cannot register.** Naming where a headless browser may go is a lead decision.
 * 2. **A minted token is origin-scoped.** The seed Northwind origin gets that application id;
 *    an unknown origin gets `null`; that token cannot then read another application's snapshot.
 */

let harness: Harness;
const createdIds: string[] = [];
const suiteStartedAt = new Date();

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness.database.unscoped('readiness-probe', async (db) => {
    if (createdIds.length > 0) {
      await db.deleteFrom('applications').where('id', 'in', createdIds).execute();
    }
    await db
      .deleteFrom('auditLog')
      .where('action', '=', 'application.registered')
      .where('createdAt', '>=', suiteStartedAt)
      .execute();
  });
  await harness.close();
});

async function get(email: string, url: string, bearer?: string) {
  const token = bearer ?? (await harness.issuer.sign({ email }));
  return harness.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function post(
  email: string,
  url: string,
  body: Record<string, unknown>,
  bearer?: string,
) {
  const token = bearer ?? (await harness.issuer.sign({ email }));
  return harness.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body,
  });
}

describe('POST /v1/applications', () => {
  it('lets a lead register an application and refuses a tester', async () => {
    const name = `Track3 ${randomUUID()}`;
    const baseUrl = `https://app-${randomUUID()}.example`;

    const refused = await post(SEED.testerEmail, '/v1/applications', {
      name,
      baseUrl,
      env: 'staging',
    });
    expect(refused.statusCode).toBe(403);

    const created = await post(SEED.leadEmail, '/v1/applications', {
      name,
      baseUrl,
      env: 'staging',
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; baseUrl: string; name: string };
    createdIds.push(body.id);
    expect(body.name).toBe(name);
    expect(body.baseUrl).toBe(baseUrl);

    const again = await post(SEED.leadEmail, '/v1/applications', {
      name,
      baseUrl: `https://other-${randomUUID()}.example`,
      env: 'development',
    });
    expect(again.statusCode).toBe(400);
    expect((again.json() as { code: string }).code).toBe('validation_failed');
  });

  it('refuses a second application for an origin this tenant already has', async () => {
    const response = await post(SEED.leadEmail, '/v1/applications', {
      name: `Dup origin ${randomUUID()}`,
      baseUrl: 'https://orders.northwind.example/extra',
      env: 'staging',
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('origin');
  });
});

describe('GET /v1/applications', () => {
  it('lists only the caller tenant', async () => {
    const ours = await get(SEED.leadEmail, '/v1/applications');
    expect(ours.statusCode).toBe(200);
    const listed = ours.json() as { applications: { id: string }[] };
    expect(listed.applications.map((row) => row.id)).toContain(SEED.applicationId);
    expect(listed.applications.map((row) => row.id)).not.toContain(NEIGHBOUR.applicationId);

    const theirs = await get(NEIGHBOUR.ownerEmail, '/v1/applications');
    const neighbourList = theirs.json() as { applications: { id: string }[] };
    expect(neighbourList.applications.map((row) => row.id)).toContain(NEIGHBOUR.applicationId);
    expect(neighbourList.applications.map((row) => row.id)).not.toContain(SEED.applicationId);
  });
});

describe('POST /v1/auth/extension-token', () => {
  it('mints a scoped token for a registered origin and a null id for an unknown one', async () => {
    const known = await post(SEED.testerEmail, '/v1/auth/extension-token', {
      origin: 'https://orders.northwind.example/orders',
    });
    expect(known.statusCode).toBe(200);
    const matched = ExtensionToken.parse(known.json());
    expect(matched.applicationId).toBe(SEED.applicationId);
    expect(matched.tenantId).toBe(SEED.tenantId);
    expect(matched.scopes).toContain('memory:read');
    expect(matched.scopes).not.toContain('seed:execute');

    const unknown = await post(SEED.testerEmail, '/v1/auth/extension-token', {
      origin: 'https://unindexed.example',
    });
    expect(unknown.statusCode).toBe(200);
    expect(ExtensionToken.parse(unknown.json()).applicationId).toBeNull();
  });

  it('will not mint from an already-minted extension token', async () => {
    const first = await post(SEED.testerEmail, '/v1/auth/extension-token', {
      origin: 'https://orders.northwind.example',
    });
    const minted = ExtensionToken.parse(first.json());

    const refresh = await post(
      SEED.testerEmail,
      '/v1/auth/extension-token',
      { origin: 'https://orders.northwind.example' },
      minted.token,
    );
    expect(refresh.statusCode).toBe(403);
  });

  it('lets the minted token read its own snapshot and not a neighbour', async () => {
    const minted = ExtensionToken.parse(
      (
        await post(SEED.testerEmail, '/v1/auth/extension-token', {
          origin: 'https://orders.northwind.example',
        })
      ).json(),
    );

    const own = await harness.app.inject({
      method: 'GET',
      url: `/v1/memory/${SEED.applicationId}/snapshot`,
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(own.statusCode).toBe(200);

    const other = await harness.app.inject({
      method: 'GET',
      url: `/v1/memory/${NEIGHBOUR.applicationId}/snapshot`,
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(other.statusCode).toBe(403);

    const unscoped = ExtensionToken.parse(
      (
        await post(SEED.testerEmail, '/v1/auth/extension-token', {
          origin: 'https://unindexed.example',
        })
      ).json(),
    );
    const wildcard = await harness.app.inject({
      method: 'GET',
      url: `/v1/memory/${SEED.applicationId}/snapshot`,
      headers: { authorization: `Bearer ${unscoped.token}` },
    });
    expect(wildcard.statusCode).toBe(403);
  });
});
