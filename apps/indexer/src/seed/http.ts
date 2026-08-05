import { toRoutePattern } from 'fingerprint';
import type { APIResponse, Browser, Page } from 'playwright';
import type { SeedJob, SeedJobResult } from 'protocol';

import type { SecretResolver } from '../crawl/secrets.js';
import type { AddressLookup, UrlPolicy } from '../crawl/url-policy.js';
import type { TenantDatabase } from '../db/pool.js';
import { SeedError } from '../errors.js';
import { findSeedApplication, type SeedApplication } from './repository.js';
import { createSeedPolicy, describe, withAuthenticatedPage, withDeadline } from './session.js';

/**
 * The API and fixture adapters: a request issued from inside the logged-in browser.
 *
 * docs/TEST-DATA-ENGINE.md § 4 puts the API adapter first in the chain — 100–400 ms against the
 * UI adapter's 3–15 s — and names its two costs plainly: it bypasses the client-side validation a
 * tester may have meant to exercise, and it breaks silently when the API changes. Both are why the
 * ledger records which adapter ran, and why verification is not optional here.
 *
 * ## The session is the browser's, not ours
 *
 * `page.request` shares the browser context's cookie jar. A replay through it carries exactly the
 * cookies the application set when `withAuthenticatedPage` logged in, which is how § 4's "reuse
 * the tester's live session" is honoured without WisprTest ever holding a credential. It is also
 * why a materializer observed with `auth: 'bearer'` is refused upstream: the token lived in the
 * application's own JavaScript, was never captured — correctly — and no cookie jar will supply it.
 *
 * ## Verification is what separates a replay from a no-op
 *
 * A create that returns 201 has not necessarily created anything. The observed request may have
 * carried a header that made it a dry run, the endpoint may accept and discard, the identifier may
 * belong to something else. So a create is only reported as succeeded once the record has been
 * read back — and when the crawl never saw a read-back request, the job still runs but the gateway
 * learns nothing that would let it mark the materializer verified. It therefore stays behind the
 * UI adapter, permanently, which is the correct outcome rather than a gap.
 */

/** The operations this module runs. `materializer.ts` runs the other two. */
export type HttpJob<
  Operation extends 'api_create' | 'api_revert' | 'fixture_create' | 'fixture_revert' =
    'api_create' | 'api_revert' | 'fixture_create' | 'fixture_revert',
> = Extract<SeedJob, { operation: Operation }>;

export interface HttpMaterializerDependencies {
  readonly database: TenantDatabase;
  readonly browser: Browser;
  readonly secrets: SecretResolver;
  readonly addressLookup?: AddressLookup;
}

/**
 * Run one job to completion.
 *
 * Never throws for an ordinary failure. A 422 from the application, a record that cannot be read
 * back and an endpoint that returned no identifier are all *results*: the gateway needs them as
 * results to record the attempt in the ledger and fall through to the next adapter.
 */
export async function materializeOverHttp(
  job: HttpJob,
  deps: HttpMaterializerDependencies,
): Promise<SeedJobResult> {
  const startedAt = Date.now();

  try {
    return await withDeadline(job.deadlineMs, run(job, deps, startedAt), () =>
      failed(job, startedAt, `the job did not finish within ${String(job.deadlineMs)}ms`),
    );
  } catch (error: unknown) {
    return failed(job, startedAt, describe(error));
  }
}

async function run(
  job: HttpJob,
  deps: HttpMaterializerDependencies,
  startedAt: number,
): Promise<SeedJobResult> {
  const application = await deps.database.withTenant(job.tenantId, (db) =>
    findSeedApplication(db, job.applicationId),
  );
  if (application === null) {
    throw new SeedError(`application ${job.applicationId} is not registered in this tenant`);
  }

  const policy = createSeedPolicy(application, deps.addressLookup);

  return await withAuthenticatedPage(
    {
      application,
      policy,
      browser: deps.browser,
      secrets: deps.secrets,
      deadlineMs: job.deadlineMs,
    },
    async (page) => {
      const context = { application, policy, page, startedAt };
      switch (job.operation) {
        case 'api_create':
          return await create(job, context, job.method, job.path, job.readBackPath);
        case 'fixture_create':
          // A fixture endpoint is the customer's own, so there is no observed read-back to verify
          // against. What sanctions it is the platform team that configured it, not our proof.
          return await create(job, context, 'POST', job.command, null);
        case 'api_revert':
          return await remove(job, context, 'DELETE', job.path, undefined);
        case 'fixture_revert':
          // The convention a fixture teardown implements: the entity and the record's identifier,
          // posted to the configured command. Documented for the customer configuring it, because
          // nothing about their endpoint is observable the way an API materializer's is.
          return await remove(job, context, 'POST', job.command, {
            entity: job.entity,
            externalRef: job.externalRef,
          });
      }
    },
  );
}

interface JobContext {
  readonly application: SeedApplication;
  readonly policy: UrlPolicy;
  readonly page: Page;
  readonly startedAt: number;
}

/* -------------------------------------------------------------------------------- create ---- */

async function create(
  job: HttpJob<'api_create' | 'fixture_create'>,
  context: JobContext,
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  readBackPath: string | null,
): Promise<SeedJobResult> {
  const url = await context.policy.assertAllowed(path, context.application.baseUrl);

  const response = await request(context, url.href, method, job.payload, job.deadlineMs);

  if (!response.ok()) {
    return failed(
      job,
      context.startedAt,
      // The status and the endpoint, never the response body. A body from a customer's
      // application is exactly the content CLAUDE.md § "PII rule" keeps out of logs and ledgers,
      // and this reason reaches both. The tester loses little: an API failure falls the chain
      // through to the UI adapter, which returns the application's own validation message from
      // the form that produced it.
      `${method} ${path} answered ${String(response.status())}`,
    );
  }

  const externalRef = await identifierOf(response);
  if (externalRef === null) {
    return failed(
      job,
      context.startedAt,
      `${method} ${path} succeeded but named no identifier in its response or Location header, ` +
        'so the record it created could never be found again or reverted',
    );
  }

  if (readBackPath !== null) {
    const failure = await verify(context, readBackPath, externalRef, job.deadlineMs);
    if (failure !== null) return failed(job, context.startedAt, failure);
  }

  return {
    jobId: job.jobId,
    operation: job.operation,
    outcome: 'succeeded',
    externalRef,
    // An HTTP replay learns an identifier and nothing about where the record is rendered. The
    // gateway derives a UI path from the indexed delete flow when a revert needs one.
    detailPath: null,
    failureReason: null,
    durationMs: Date.now() - context.startedAt,
  };
}

/**
 * Prove the record exists by issuing the read the crawl observed.
 *
 * Returns the failure reason, or null when the record is there. § 4: "Verification: issue the
 * observed read-back request and assert the record exists."
 */
async function verify(
  context: JobContext,
  readBackPath: string,
  externalRef: string,
  deadlineMs: number,
): Promise<string | null> {
  const path = substitute(readBackPath, externalRef);
  const url = await context.policy.assertAllowed(path, context.application.baseUrl);
  const response = await request(context, url.href, 'GET', undefined, deadlineMs);

  if (response.ok()) return null;

  return (
    `the record could not be read back at ${path} (${String(response.status())}) — the replayed ` +
    'request was accepted but appears to have created nothing'
  );
}

/* -------------------------------------------------------------------------------- revert ---- */

async function remove(
  job: HttpJob<'api_revert' | 'fixture_revert'>,
  context: JobContext,
  method: 'DELETE' | 'POST',
  path: string,
  payload: unknown,
): Promise<SeedJobResult> {
  const url = await context.policy.assertAllowed(path, context.application.baseUrl);
  const response = await request(context, url.href, method, payload, job.deadlineMs);

  // A record that is already gone is reverted, not failed. The same judgement the UI adapter
  // makes: the ledger's purpose is that the record is not there, and it is not there.
  if (response.ok() || response.status() === 404 || response.status() === 410) {
    return {
      jobId: job.jobId,
      operation: job.operation,
      outcome: 'succeeded',
      externalRef: null,
      detailPath: null,
      failureReason: null,
      durationMs: Date.now() - context.startedAt,
    };
  }

  return failed(
    job,
    context.startedAt,
    `${method} ${path} answered ${String(response.status())}, so ${job.externalRef} is still there`,
  );
}

/* ------------------------------------------------------------------------------ plumbing ---- */

/**
 * Issue one request through the page's own context.
 *
 * `failOnStatusCode` stays off because a 4xx is an answer this adapter has to report, not an
 * exception: the chain needs the concrete status to record the attempt and fall through.
 */
async function request(
  context: JobContext,
  url: string,
  method: string,
  payload: unknown,
  deadlineMs: number,
): Promise<APIResponse> {
  return await context.page.request.fetch(url, {
    method,
    ...(payload === undefined ? {} : { data: payload }),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    failOnStatusCode: false,
    timeout: deadlineMs,
  });
}

/**
 * The identifier the application gave the new record.
 *
 * Two sources, in the order they can be trusted. A `Location` header is the application saying
 * where the record now lives, and its identifier segment is read with the same generalisation the
 * crawler uses to turn `/orders/1841` into `/orders/:id` — asking `toRoutePattern` rather than
 * inventing a second notion of what an identifier looks like. Failing that, the response body.
 */
async function identifierOf(response: APIResponse): Promise<string | null> {
  const location = response.headers().location;
  if (location !== undefined) {
    const segment = identifierSegment(pathOfMaybeRelative(location));
    if (segment !== null) return segment;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not JSON, or empty. Not an error by itself — the Location header may already have answered.
    return null;
  }

  return identifierInBody(body, 0);
}

/**
 * Find the record's id in a response body.
 *
 * `id` is a convention rather than an application's own vocabulary, the same way `:id` segments
 * are during indexing — so reading it here is not the hardcoded per-app knowledge CLAUDE.md
 * forbids. Envelopes are unwrapped **by shape, not by name**: an object with exactly one key is a
 * wrapper whatever it is called, so `{data:…}`, `{result:…}` and `{order:…}` all work without this
 * module holding a list of names some application happens to use.
 */
function identifierInBody(body: unknown, depth: number): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;
  const direct = record.id;
  if (typeof direct === 'string' && direct !== '') return direct;
  if (typeof direct === 'number') return String(direct);

  const keys = Object.keys(record);
  // Two levels is enough for `{data:{...}}` and one envelope around it. Deeper is not an envelope,
  // it is a document, and hunting through it would eventually find somebody else's id.
  if (depth < 2 && keys.length === 1) {
    const only = keys[0];
    return only === undefined ? null : identifierInBody(record[only], depth + 1);
  }

  return null;
}

/** The identifier segment of a path, by the crawler's own generalisation. */
export function identifierSegment(path: string): string | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  const pattern = toRoutePattern(path)
    .split('/')
    .filter((segment) => segment !== '');

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const generalized = pattern[index];
    const literal = segments[index];
    if (literal !== undefined && generalized?.startsWith(':') === true) {
      return literal;
    }
  }
  return null;
}

/** A `Location` may be absolute or relative; only its path matters here. */
function pathOfMaybeRelative(location: string): string {
  try {
    return new URL(location).pathname;
  } catch {
    return location;
  }
}

/**
 * Put the record's identifier into the observed read-back pattern.
 *
 * A pattern with anything other than exactly one dynamic segment is refused rather than guessed.
 * With none there is nothing to substitute and the read would not be about this record; with two,
 * choosing which slot the identifier fills would mean reading back somebody else's record and
 * concluding ours exists.
 */
function substitute(pattern: string, externalRef: string): string {
  const dynamic = pattern.split('/').filter((segment) => segment.startsWith(':'));

  if (dynamic.length !== 1) {
    throw new SeedError(
      `the observed read-back path ${pattern} carries ${String(dynamic.length)} identifiers, so ` +
        'the created record cannot be addressed unambiguously',
    );
  }

  return pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? encodeURIComponent(externalRef) : segment))
    .join('/');
}

function failed(job: HttpJob, startedAt: number, reason: string): SeedJobResult {
  return {
    jobId: job.jobId,
    operation: job.operation,
    outcome: 'failed',
    externalRef: null,
    detailPath: null,
    failureReason: reason,
    durationMs: Date.now() - startedAt,
  };
}
