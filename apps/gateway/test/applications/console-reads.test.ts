import { Alias, ElementRecord, ScreenNode, Session, SeedLedgerEntry } from 'protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { NEIGHBOUR, SEED, startHarness, type Harness } from '../support/harness.js';

/**
 * The console's read APIs against the seed fixture.
 *
 * Enrichment, session list, memory browse, schemas and ledger have to answer from the rows that
 * already exist — never from invented coverage. Neighbour ids stay invisible.
 */

let harness: Harness;

const SCREEN_ID = '55555555-5555-4555-8555-555555555551';

const EnrichedApplication = z.object({
  id: z.uuid(),
  memoryVersion: z.number().nullable(),
  memoryVersionId: z.uuid().nullable(),
  indexedAt: z.string().nullable(),
  screenCount: z.number(),
  elementCount: z.number(),
  openDriftCount: z.number(),
});
const ApplicationList = z.object({
  applications: z.array(
    z.object({
      id: z.uuid(),
      memoryVersion: z.number().nullable(),
      screenCount: z.number(),
    }),
  ),
});
const SessionList = z.object({
  sessions: z.array(z.object({ id: z.uuid() })),
  total: z.number(),
});
const LedgerBody = z.object({
  sessionId: z.uuid(),
  entries: z.array(z.unknown()),
});
const ScreenBrowse = z.object({
  memoryVersionId: z.uuid(),
  total: z.number(),
  screens: z.array(z.unknown()),
});
const ElementBrowse = z.object({
  total: z.number(),
  elements: z.array(z.unknown()),
});
const AliasBrowse = z.object({
  total: z.number(),
  aliases: z.array(z.unknown()),
});
const GraphBrowse = z.object({
  edges: z.array(z.unknown()),
});
const ExtensionMint = z.object({ token: z.string() });
const SchemasBody = z.object({
  applicationId: z.uuid(),
  memoryVersionId: z.uuid(),
  schemas: z.array(z.unknown()),
});
const DriftPage = z.object({
  total: z.number(),
  reports: z.array(z.unknown()),
});

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
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

async function post(email: string, url: string, body: Record<string, unknown>) {
  const token = await harness.issuer.sign({ email });
  return harness.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body,
  });
}

describe('GET /v1/applications enrichment', () => {
  it('attaches the active version counts for a seeded application', async () => {
    const response = await get(SEED.leadEmail, `/v1/applications/${SEED.applicationId}`);
    expect(response.statusCode).toBe(200);
    const body = EnrichedApplication.parse(response.json());
    expect(body.id).toBe(SEED.applicationId);
    expect(body.memoryVersion).toBe(1);
    expect(body.memoryVersionId).toBe(SEED.memoryVersionId);
    expect(body.indexedAt).not.toBeNull();
    expect(body.screenCount).toBeGreaterThanOrEqual(1);
    expect(body.elementCount).toBeGreaterThanOrEqual(1);
    expect(body.openDriftCount).toBeGreaterThanOrEqual(0);
  });

  it('lists those same counts without exposing a neighbour application', async () => {
    const response = await get(SEED.leadEmail, '/v1/applications');
    expect(response.statusCode).toBe(200);
    const listed = ApplicationList.parse(response.json());
    const ours = listed.applications.find((row) => row.id === SEED.applicationId);
    expect(ours?.memoryVersion).toBe(1);
    expect(ours?.screenCount).toBeGreaterThanOrEqual(1);
    expect(listed.applications.map((row) => row.id)).not.toContain(NEIGHBOUR.applicationId);
  });
});

describe('GET /v1/sessions', () => {
  it('lists a session for this tenant and not the neighbour', async () => {
    const opened = await post(SEED.testerEmail, '/v1/sessions', {
      applicationId: SEED.applicationId,
      memoryVersionId: SEED.memoryVersionId,
    });
    expect(opened.statusCode).toBe(201);
    const session = Session.parse(opened.json());

    const listed = await get(
      SEED.leadEmail,
      `/v1/sessions?applicationId=${SEED.applicationId}&limit=50`,
    );
    expect(listed.statusCode).toBe(200);
    const body = SessionList.parse(listed.json());
    expect(body.sessions.map((row) => row.id)).toContain(session.id);
    expect(body.total).toBeGreaterThanOrEqual(1);

    const neighbour = await get(
      NEIGHBOUR.ownerEmail,
      `/v1/sessions?applicationId=${SEED.applicationId}`,
    );
    expect(neighbour.statusCode).toBe(200);
    const theirs = SessionList.parse(neighbour.json());
    expect(theirs.sessions.map((row) => row.id)).not.toContain(session.id);
  });

  it('refuses a malformed application id', async () => {
    const response = await get(SEED.leadEmail, '/v1/sessions?applicationId=not-a-uuid');
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /v1/sessions/:id/ledger', () => {
  it('returns an empty ledger for a session that has seeded nothing', async () => {
    const opened = await post(SEED.testerEmail, '/v1/sessions', {
      applicationId: SEED.applicationId,
      memoryVersionId: SEED.memoryVersionId,
    });
    const session = Session.parse(opened.json());

    const response = await get(SEED.leadEmail, `/v1/sessions/${session.id}/ledger`);
    expect(response.statusCode).toBe(200);
    const body = LedgerBody.parse(response.json());
    expect(body.sessionId).toBe(session.id);
    expect(body.entries).toEqual([]);
    for (const entry of body.entries) SeedLedgerEntry.parse(entry);
  });
});

describe('GET /v1/memory/:appId browse', () => {
  it('pages screens, elements and aliases of the active version', async () => {
    const screens = await get(SEED.leadEmail, `/v1/memory/${SEED.applicationId}/screens?limit=10`);
    expect(screens.statusCode).toBe(200);
    const screenBody = ScreenBrowse.parse(screens.json());
    expect(screenBody.memoryVersionId).toBe(SEED.memoryVersionId);
    expect(screenBody.total).toBeGreaterThanOrEqual(1);
    const screen = ScreenNode.parse(screenBody.screens[0]);
    expect(screen.id).toBe(SCREEN_ID);

    const elements = await get(
      SEED.leadEmail,
      `/v1/memory/${SEED.applicationId}/elements?screenId=${SCREEN_ID}`,
    );
    expect(elements.statusCode).toBe(200);
    const elementBody = ElementBrowse.parse(elements.json());
    expect(elementBody.total).toBeGreaterThanOrEqual(1);
    const element = ElementRecord.parse(elementBody.elements[0]);
    expect(element.elementKey).toBe('orders.filter.pending');
    expect(JSON.stringify(element.fingerprint)).not.toMatch(/priya|@northwind/i);

    const aliases = await get(SEED.leadEmail, `/v1/memory/${SEED.applicationId}/aliases`);
    expect(aliases.statusCode).toBe(200);
    const aliasBody = AliasBrowse.parse(aliases.json());
    expect(aliasBody.total).toBeGreaterThanOrEqual(1);
    expect(Alias.parse(aliasBody.aliases[0]).phrase).toBe('the pending filter');

    const graph = await get(SEED.leadEmail, `/v1/memory/${SEED.applicationId}/graph`);
    expect(graph.statusCode).toBe(200);
    expect(GraphBrowse.parse(graph.json()).edges).toEqual([]);
  });

  it('will not let a neighbour-scoped extension token browse this application', async () => {
    const minted = await post(SEED.testerEmail, '/v1/auth/extension-token', {
      origin: 'https://orders.northwind.example',
    });
    const token = ExtensionMint.parse(minted.json()).token;

    const own = await get(SEED.testerEmail, `/v1/memory/${SEED.applicationId}/screens`, token);
    expect(own.statusCode).toBe(200);

    const other = await get(
      SEED.testerEmail,
      `/v1/memory/${NEIGHBOUR.applicationId}/screens`,
      token,
    );
    expect(other.statusCode).toBe(403);
  });
});

describe('GET /v1/applications/:id/schemas', () => {
  it('returns the learned schemas for the active version', async () => {
    const response = await get(SEED.leadEmail, `/v1/applications/${SEED.applicationId}/schemas`);
    expect(response.statusCode).toBe(200);
    const body = SchemasBody.parse(response.json());
    expect(body.applicationId).toBe(SEED.applicationId);
    expect(body.memoryVersionId).toBe(SEED.memoryVersionId);
    expect(Array.isArray(body.schemas)).toBe(true);
  });
});

describe('GET /v1/drift/:appId pagination', () => {
  it('accepts a page and does not invent reports', async () => {
    const response = await get(SEED.leadEmail, `/v1/drift/${SEED.applicationId}?limit=1&offset=0`);
    expect(response.statusCode).toBe(200);
    const body = DriftPage.parse(response.json());
    expect(body.total).toBeGreaterThanOrEqual(0);
    expect(body.reports.length).toBeLessThanOrEqual(1);
  });
});
