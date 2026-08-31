#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const fetch = globalThis.fetch.bind(globalThis);
const { AbortSignal, Headers, URL, URLSearchParams, performance } = globalThis;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONCURRENCY = 50;
const LATENCY_BUDGET_MS = 800;
const REQUIRED_SERVICES = ['postgres', 'redis', 'qdrant', 'minio', 'dex'];
const APPLICATION_ID = '33333333-3333-4333-8333-333333333331';
const MEMORY_VERSION_ID = '44444444-4444-4444-8444-444444444441';
const ELEMENT_ID = '66666666-6666-4666-8666-666666666661';
const APPLICATION_ORIGIN = 'https://orders.northwind.example';
const TESTER_EMAIL = 'daniel.tester@northwind.example';
const TESTER_PASSWORD = 'daniel-local-dev-only';
const STATE_FINGERPRINT = 'a'.repeat(64);

class LoadGateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'LoadGateError';
  }
}

function loadEnvironment() {
  try {
    process.loadEnvFile(resolve(ROOT, '.env'));
  } catch (error) {
    throw new LoadGateError('cannot load .env; run "make db-up" to create local configuration', {
      cause: error,
    });
  }

  const required = [
    'GATEWAY_HOST',
    'GATEWAY_PORT',
    'OIDC_ISSUER_URL',
    'OIDC_AUDIENCE',
    'OIDC_CLIENT_ID',
    'OIDC_REDIRECT_URI',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new LoadGateError(`missing load-test configuration: ${missing.join(', ')}`);
  }
}

function requireStack() {
  const result = spawnSync('docker', ['compose', 'ps', '--status', 'running', '--services'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.error !== undefined) {
    throw new LoadGateError(`docker compose could not start: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new LoadGateError('docker compose is unavailable; run "make db-up" first');
  }
  const running = result.stdout.split(/\s+/).filter(Boolean);
  const missing = REQUIRED_SERVICES.filter((service) => !running.includes(service));
  if (missing.length > 0) {
    throw new LoadGateError(
      `Compose services are not healthy: ${missing.join(', ')}. Run "make db-up db-migrate db-seed" first.`,
    );
  }
}

function buildGateway() {
  const result = spawnSync('pnpm', ['--filter', 'gateway', 'build'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'inherit',
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new LoadGateError('the production gateway build failed', { cause: result.error });
  }
}

function gatewayOrigin() {
  const host = process.env.GATEWAY_HOST === '0.0.0.0' ? '127.0.0.1' : process.env.GATEWAY_HOST;
  return `http://${host}:${process.env.GATEWAY_PORT}`;
}

async function assertPortFree(origin) {
  try {
    await fetch(new URL('/healthz', origin), { signal: AbortSignal.timeout(500) });
  } catch {
    return;
  }
  throw new LoadGateError(
    `${origin} is already serving HTTP; stop the existing gateway so the load gate owns the process`,
  );
}

async function startGateway(origin) {
  await assertPortFree(origin);
  const child = spawn(process.execPath, ['apps/gateway/dist/main.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'inherit',
  });

  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new LoadGateError(`gateway exited during startup with code ${String(child.exitCode)}`);
    }
    try {
      const response = await fetch(new URL('/readyz', origin), {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return { child, exited };
    } catch {
      // The socket is expected to refuse connections while Fastify is still booting.
    }
    await delay(500);
  }

  child.kill('SIGTERM');
  throw new LoadGateError('gateway did not become ready within 30 seconds');
}

async function stopGateway(gateway) {
  if (gateway.child.exitCode !== null) {
    if (gateway.child.exitCode !== 0) {
      throw new LoadGateError(`gateway exited with code ${String(gateway.child.exitCode)}`);
    }
    return;
  }
  gateway.child.kill('SIGTERM');
  const result = await Promise.race([gateway.exited, delay(15_000, null)]);
  if (result === null && gateway.child.exitCode === null) {
    gateway.child.kill('SIGKILL');
    await gateway.exited;
    throw new LoadGateError('gateway did not complete graceful shutdown within 15 seconds');
  }
  if (result !== null && result.code !== 0) {
    throw new LoadGateError(
      `gateway shutdown failed with ${result.signal === null ? `code ${String(result.code)}` : `signal ${result.signal}`}`,
    );
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

class CookieJar {
  #cookies = new Map();

  apply(headers) {
    if (this.#cookies.size > 0) {
      headers.set(
        'cookie',
        [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
  }

  capture(headers) {
    const values =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : [headers.get('set-cookie')].filter(Boolean);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
}

async function dexRequest(jar, url, init = {}) {
  const headers = new Headers(init.headers);
  jar.apply(headers);
  const response = await fetch(url, { ...init, headers, redirect: 'manual' });
  jar.capture(response.headers);
  return response;
}

function requiredLocation(response, step) {
  const location = response.headers.get('location');
  if (location === null) {
    throw new LoadGateError(`Dex ${step} did not return a redirect`);
  }
  return location;
}

async function obtainOidcAccessToken() {
  const issuer = process.env.OIDC_ISSUER_URL;
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));
  const nonce = base64url(randomBytes(16));
  const authorization = new URL(`${issuer}/auth`);
  authorization.search = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.OIDC_CLIENT_ID,
    redirect_uri: process.env.OIDC_REDIRECT_URI,
    scope: `openid email profile audience:server:client_id:${process.env.OIDC_AUDIENCE}`,
    audience: process.env.OIDC_AUDIENCE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  const jar = new CookieJar();
  const connector = await dexRequest(jar, authorization);
  const loginPage = await dexRequest(
    jar,
    new URL(requiredLocation(connector, 'authorization'), authorization),
  );
  const credentials = new URLSearchParams({
    login: TESTER_EMAIL,
    password: TESTER_PASSWORD,
  });
  let callback = await dexRequest(
    jar,
    new URL(requiredLocation(loginPage, 'connector'), authorization),
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: credentials,
    },
  );

  let callbackUrl = new URL(requiredLocation(callback, 'login'), authorization);
  if (callbackUrl.pathname.startsWith('/dex/approval')) {
    callback = await dexRequest(jar, callbackUrl);
    callbackUrl = new URL(requiredLocation(callback, 'approval'), authorization);
  }

  const code = callbackUrl.searchParams.get('code');
  if (code === null || callbackUrl.searchParams.get('state') !== state) {
    throw new LoadGateError('Dex returned an invalid authorization callback');
  }

  const tokens = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.OIDC_REDIRECT_URI,
      client_id: process.env.OIDC_CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!tokens.ok) throw new LoadGateError(`Dex token exchange returned HTTP ${tokens.status}`);
  const body = await tokens.json();
  if (typeof body.access_token !== 'string') {
    throw new LoadGateError('Dex token exchange returned no access token');
  }
  return body.access_token;
}

function record(timings, operation, startedAt) {
  const elapsed = performance.now() - startedAt;
  const values = timings.get(operation) ?? [];
  values.push(elapsed);
  timings.set(operation, values);
}

async function request(timings, operation, url, init) {
  const startedAt = performance.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  record(timings, operation, startedAt);
  if (!response.ok) {
    throw new LoadGateError(`${operation} returned HTTP ${String(response.status)}`);
  }
  return response;
}

function bearer(token, body) {
  return {
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function loadSteps(sessionId, evidence) {
  return Array.from({ length: 5 }, (_, ordinal) => ({
    id: randomUUID(),
    sessionId,
    ordinal,
    utterance: 'show pending orders',
    intent: {
      verb: 'filter',
      targetPhrase: 'pending',
      constraints: [],
      stateFingerprint: STATE_FINGERPRINT,
      candidateElementKeys: ['orders.filter.pending'],
    },
    resolution: {
      outcome: 'resolved',
      elementId: ELEMENT_ID,
      elementKey: 'orders.filter.pending',
      confidence: 0.97,
      tier: 'T0',
      latencyMs: 8,
      candidates: [],
    },
    elementId: null,
    tier: 'T0',
    confidence: 0.97,
    actionClass: 'R',
    latencyMs: 120,
    outcome: 'executed',
    evidence: ordinal === 0 ? [evidence] : [],
    createdAt: new Date().toISOString(),
  }));
}

async function runSession(index, oidcToken, origin, timings) {
  let extensionToken;
  let sessionId;
  let closed = false;

  try {
    const minted = await request(
      timings,
      'extension_token',
      new URL('/v1/auth/extension-token', origin),
      {
        method: 'POST',
        ...bearer(oidcToken, { origin: APPLICATION_ORIGIN }),
      },
    );
    const tokenBody = await minted.json();
    if (typeof tokenBody.token !== 'string') {
      throw new LoadGateError(`session ${String(index)} received a malformed extension token`);
    }
    extensionToken = tokenBody.token;

    await request(
      timings,
      'memory_snapshot',
      new URL(`/v1/memory/${APPLICATION_ID}/snapshot`, origin),
      bearer(extensionToken),
    );

    const opened = await request(timings, 'session_open', new URL('/v1/sessions', origin), {
      method: 'POST',
      ...bearer(extensionToken, {
        applicationId: APPLICATION_ID,
        memoryVersionId: MEMORY_VERSION_ID,
      }),
    });
    const openedBody = await opened.json();
    if (typeof openedBody.id !== 'string') {
      throw new LoadGateError(`session ${String(index)} received a malformed session`);
    }
    sessionId = openedBody.id;

    const bytes = Buffer.from('redacted load evidence', 'utf8');
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const ticket = await request(
      timings,
      'evidence_ticket',
      new URL(`/v1/sessions/${sessionId}/evidence`, origin),
      {
        method: 'POST',
        ...bearer(extensionToken, {
          kind: 'dom_snapshot',
          stepOrdinal: 0,
          contentHash,
          // Pinned to the kind by `EvidenceUploadRequest` (PR #41). A DOM snapshot stored as
          // `text/html` is served back as HTML from object storage, which is why the contract
          // makes that unrepresentable rather than merely discouraged. This script sent
          // `text/html` until the contract changed under it, and nothing caught that because
          // `make load-test` is not in CI.
          contentType: 'text/plain',
        }),
      },
    );
    const ticketBody = await ticket.json();
    if (typeof ticketBody.uploadUrl !== 'string' || typeof ticketBody.storageKey !== 'string') {
      throw new LoadGateError(`session ${String(index)} received a malformed evidence ticket`);
    }

    await request(timings, 'evidence_upload', ticketBody.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: bytes,
    });
    const evidence = {
      kind: 'dom_snapshot',
      storageKey: ticketBody.storageKey,
      contentHash,
      capturedAt: new Date().toISOString(),
    };

    await request(timings, 'step_ingest', new URL(`/v1/sessions/${sessionId}/steps`, origin), {
      method: 'POST',
      ...bearer(extensionToken, { steps: loadSteps(sessionId, evidence) }),
    });

    await request(timings, 'session_close', new URL(`/v1/sessions/${sessionId}`, origin), {
      method: 'PATCH',
      ...bearer(extensionToken, { status: 'closed' }),
    });
    closed = true;
  } finally {
    if (!closed && extensionToken !== undefined && sessionId !== undefined) {
      try {
        await fetch(new URL(`/v1/sessions/${sessionId}`, origin), {
          method: 'PATCH',
          ...bearer(extensionToken, { status: 'closed' }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // The final report still fails on the original error; this is best-effort cleanup only.
      }
    }
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

async function main() {
  loadEnvironment();
  requireStack();
  buildGateway();
  const origin = gatewayOrigin();
  const gateway = await startGateway(origin);
  const timings = new Map();

  try {
    const oidcToken = await obtainOidcAccessToken();
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, index) =>
        runSession(index, oidcToken, origin, timings),
      ),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    const summary = Object.fromEntries(
      [...timings.entries()].map(([operation, values]) => [
        operation,
        {
          count: values.length,
          p50_ms: Number(percentile(values, 0.5).toFixed(2)),
          p95_ms: Number(percentile(values, 0.95).toFixed(2)),
          max_ms: Number(Math.max(...values).toFixed(2)),
        },
      ]),
    );

    process.stdout.write(
      `${JSON.stringify({
        event: 'load.summary',
        concurrent_sessions: CONCURRENCY,
        latency_budget_ms: LATENCY_BUDGET_MS,
        failed_sessions: failures.length,
        operations: summary,
      })}\n`,
    );

    if (failures.length > 0) {
      const reasons = failures
        .slice(0, 5)
        .map((result) =>
          result.status === 'rejected' && result.reason instanceof Error
            ? result.reason.message
            : String(result),
        );
      throw new LoadGateError(
        `${String(failures.length)} of ${String(CONCURRENCY)} sessions failed: ${reasons.join('; ')}`,
      );
    }

    const slow = Object.entries(summary).filter(
      ([, measurement]) => measurement.p95_ms >= LATENCY_BUDGET_MS,
    );
    if (slow.length > 0) {
      throw new LoadGateError(
        `p95 exceeded ${String(LATENCY_BUDGET_MS)}ms: ${slow
          .map(([name, value]) => `${name}=${String(value.p95_ms)}ms`)
          .join(', ')}`,
      );
    }
  } finally {
    await stopGateway(gateway);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`load gate failed: ${message}\n`);
  process.exitCode = 1;
});
