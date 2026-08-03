import type { Browser, Page } from 'playwright';
import { pathOf, toRoutePattern } from 'fingerprint';
import type { UiSeedJob, UiSeedResult } from 'protocol';

import { applyFormLogin, prepareAuth } from '../crawl/auth.js';
import { openSession, type SessionBounds } from '../crawl/browser.js';
import type { SecretResolver } from '../crawl/secrets.js';
import { createUrlPolicy, type AddressLookup, type UrlPolicy } from '../crawl/url-policy.js';
import type { TenantDatabase } from '../db/pool.js';
import { SeedError } from '../errors.js';
import type {
  LocatedControl,
  RecordControlLocation,
  RecordControlOptions,
  SeedLocateOptions,
  SeedLocateResult,
  SeedTarget,
  SubmitLocation,
} from './located.js';
import { findSeedApplication, loadIndexedElements, type SeedApplication } from './repository.js';

/**
 * The UI materializer: the runtime executor, pointed at a create form.
 *
 * docs/TEST-DATA-ENGINE.md § 4 calls this the adapter that is "always available" — it needs no
 * observed API, it exercises the application's real client-side validation, and it survives an API
 * change that would silently break a replayed request. It is also the slow one, which is why it
 * sits at the bottom of the fallback chain rather than the top.
 *
 * ## It resolves controls the way the runtime does
 *
 * Every control is found by scoring its *stored fingerprint* against the live page, through
 * `packages/fingerprint` (see `crawl/in-page/seed.ts`). Not by CSS selector, not by name
 * attribute, not by label text. CLAUDE.md rule #4 is the reason, and the payoff is concrete: a
 * form whose markup was restyled between the index and the seed still fills, and a form that
 * genuinely changed fails with the field it could not find rather than typing into the wrong box.
 *
 * ## Every failure is a sentence, not a status
 *
 * A tester whose seed failed needs to know whether to retry, re-index or give up, and only a
 * concrete reason distinguishes those. So every exit through {@link failed} names what could not
 * be done — the field whose control is gone, the form with no submit button, the submit that led
 * nowhere identifiable.
 *
 * ## It never decides *whether* to write
 *
 * Policy, approval and the ledger belong to the gateway. By the time a job reaches this worker,
 * a human has approved a preview (§ 6) and the environment has been checked. This code's only
 * judgement is whether the form it was sent to is still the form memory recorded.
 */

/** Attribute the locator stamps. Distinct from the crawl's so the two passes cannot collide. */
const SEED_MARKER_ATTRIBUTE = 'data-wispr-seed';

interface SubmitOptions {
  readonly markerAttribute: string;
  readonly anchorMarker: number;
  readonly submitMarker: number;
}

/**
 * The injected bundle, as the page sees it.
 *
 * Every `page.evaluate` below runs inside the document, where `globalThis.__wisprIndexer` is the
 * IIFE `crawl/fingerprint-bundle.ts` installed — the same bundle the crawl uses, carrying the same
 * copy of `packages/fingerprint`.
 *
 * Each callback reaches for that global itself rather than through a helper in this module.
 * Playwright serialises the callback's *source* and evaluates it in the page, so anything it
 * closes over here does not exist there: a shared accessor typechecks perfectly and fails at
 * runtime with `ReferenceError`, which is a mistake worth only making once.
 */
interface InjectedBundle {
  locateControls: (options: SeedLocateOptions) => SeedLocateResult;
  locateRecordControl: (options: RecordControlOptions) => RecordControlLocation;
  locateSubmit: (options: SubmitOptions) => SubmitLocation;
}

/** Marker reserved for the submit control, above anything the field pass will mint. */
const SUBMIT_MARKER = 100_000;

/** Marker reserved for the one control a revert drives. */
const RECORD_CONTROL_MARKER = 100_001;

/**
 * Integrity floor for accepting a live element as an indexed control.
 *
 * Below the runtime's resolution threshold deliberately — see `SeedLocateOptions.threshold`. The
 * two answer different questions, and using the stricter one here would refuse materializations
 * over cosmetic drift that the tester would have been happy with.
 */
const CONTROL_MATCH_THRESHOLD = 0.55;

/**
 * The viewport controls are located against.
 *
 * Fingerprint geometry is normalised against the viewport, so the bbox signal only agrees with
 * the stored value if the window is the size it was indexed at. This is the crawl's default, and
 * a mismatch degrades one signal of seven rather than breaking the match outright.
 */
const SEED_VIEWPORT = { width: 1440, height: 900 } as const;

export interface MaterializerDependencies {
  readonly database: TenantDatabase;
  readonly browser: Browser;
  readonly secrets: SecretResolver;
  readonly addressLookup?: AddressLookup;
}

/**
 * Run one job to completion.
 *
 * Never throws for an ordinary failure: a form that moved, a control that is gone and a delete
 * flow that did not delete are all *results*, and the gateway needs them as results to record the
 * attempt in the ledger and fall through the chain. Only a broken job — one whose ids do not
 * resolve at all — is exceptional, and even that is caught at the boundary and returned.
 */
export async function materialize(
  job: UiSeedJob,
  deps: MaterializerDependencies,
): Promise<UiSeedResult> {
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
  job: UiSeedJob,
  deps: MaterializerDependencies,
  startedAt: number,
): Promise<UiSeedResult> {
  const context = await loadContext(job, deps);
  const bounds: SessionBounds = {
    viewport: SEED_VIEWPORT,
    navigationTimeoutMs: Math.min(job.deadlineMs, 60_000),
  };

  const auth = await prepareAuth(context.application.authProfile, deps.secrets);
  const session = await openSession({ browser: deps.browser, bounds, auth });

  try {
    await applyFormLogin({
      page: session.page,
      profile: context.application.authProfile,
      baseUrl: context.application.baseUrl,
      bounds,
      policy: context.policy,
      resolver: deps.secrets,
    });

    return job.operation === 'create'
      ? await create(job, context, session.page, startedAt)
      : await revert(job, context, session.page, startedAt);
  } finally {
    await session.close();
  }
}

/** Everything a job needs from the database and from the application's registration. */
interface JobContext {
  readonly application: SeedApplication;
  readonly policy: UrlPolicy;
  readonly targets: readonly SeedTarget[];
  /** The route the job navigates to first: the create form, or the record's detail page. */
  readonly entryPath: string;
}

async function loadContext(job: UiSeedJob, deps: MaterializerDependencies): Promise<JobContext> {
  const elementKeys =
    job.operation === 'create' ? job.values.map((value) => value.controlElementKey) : [job.flow];

  const loaded = await deps.database.withTenant(job.tenantId, async (db) => {
    const application = await findSeedApplication(db, job.applicationId);
    const elements = await loadIndexedElements(db, job.memoryVersionId, elementKeys);
    return { application, elements };
  });

  if (loaded.application === null) {
    throw new SeedError(`application ${job.applicationId} is not registered in this tenant`);
  }

  const missing = elementKeys.filter((key) => !loaded.elements.has(key));
  if (missing.length > 0) {
    throw new SeedError(
      `memory version ${job.memoryVersionId} does not hold ${missing.join(', ')} — ` +
        'the plan was composed against a different version of this application',
    );
  }

  const targets: SeedTarget[] =
    job.operation === 'create'
      ? job.values.map((value) => ({
          field: value.field,
          elementKey: value.controlElementKey,
          fingerprint: element(loaded.elements, value.controlElementKey).fingerprint,
        }))
      : [
          {
            field: 'delete',
            elementKey: job.flow,
            fingerprint: element(loaded.elements, job.flow).fingerprint,
          },
        ];

  // Where the delete control was seen. On a detail route that is the record's own page, reached
  // by substituting its identifier; on a list route it is the list, and the record's own path is
  // what picks its row out once the page is open.
  const entryPath =
    job.operation === 'create'
      ? job.route
      : flowPath(element(loaded.elements, job.flow).routePattern, job.detailPath);

  return {
    application: loaded.application,
    // The allowlist is the application's own origin: a seed job navigates to the application it
    // was registered for and nowhere else, so there is nothing a tenant needs to configure and
    // nothing a compromised plan could redirect. The SSRF checks that matter — scheme, embedded
    // credentials, private address ranges — still run on every navigation.
    policy: createUrlPolicy(
      { allowedOrigins: [originOf(loaded.application.baseUrl)], routeAllowlist: ['/'] },
      deps.addressLookup ?? defaultAddressLookup,
    ),
    targets,
    entryPath,
  };
}

/* -------------------------------------------------------------------------------- create ---- */

async function create(
  job: Extract<UiSeedJob, { operation: 'create' }>,
  context: JobContext,
  page: Page,
  startedAt: number,
): Promise<UiSeedResult> {
  const formUrl = await context.policy.assertAllowed(
    context.entryPath,
    context.application.baseUrl,
  );
  await page.goto(formUrl.href, { waitUntil: 'networkidle' });

  const located = await locate(page, context.targets);
  if (located.missing.length > 0) {
    return failed(job, startedAt, describeMissing(located));
  }

  const unwritable = located.located.filter((control) => !control.writable);
  if (unwritable.length > 0) {
    return failed(
      job,
      startedAt,
      `the form renders ${listFields(unwritable)} as disabled or read-only, so ${
        unwritable.length === 1 ? 'it cannot be' : 'they cannot be'
      } filled`,
    );
  }

  for (const control of located.located) {
    const value = job.values.find((candidate) => candidate.field === control.field);
    // Unreachable: the targets were built from these values. Checked because filling a control
    // with `undefined` would submit a form that looks filled and is not.
    if (value === undefined) {
      return failed(job, startedAt, `no value was carried for ${control.field}`);
    }
    const failure = await fill(page, control, value.value);
    if (failure !== null) return failed(job, startedAt, failure);
  }

  const anchor = located.located[0];
  if (anchor === undefined) {
    return failed(job, startedAt, 'the plan named no controls to fill');
  }

  const submit = await page.evaluate<SubmitLocation, SubmitOptions>(
    (options) =>
      (globalThis as unknown as { __wisprIndexer: InjectedBundle }).__wisprIndexer.locateSubmit(
        options,
      ),
    {
      markerAttribute: SEED_MARKER_ATTRIBUTE,
      anchorMarker: anchor.marker,
      submitMarker: SUBMIT_MARKER,
    },
  );

  if (submit.marker === null) {
    return failed(job, startedAt, submit.reason ?? 'the form could not be submitted');
  }

  const before = pathOf(page.url());
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.locator(markerSelector(submit.marker)).click(),
  ]);

  const landed = pathOf(page.url());
  if (landed === before) {
    // The form re-rendered on the same route, which is what client-side validation looks like
    // from out here. That is the UI adapter earning its place in the chain — the API adapter
    // would have written the record — but it still has to be reported as a failure.
    return failed(
      job,
      startedAt,
      `the form did not submit: the application stayed on ${before}, which usually means it ` +
        'rejected one of the composed values',
    );
  }

  const externalRef = identifierSegment(landed);
  if (externalRef === null) {
    return failed(
      job,
      startedAt,
      `the form submitted and landed on ${landed}, which carries no record identifier — ` +
        'without one the record cannot be verified or reverted',
    );
  }

  return {
    jobId: job.jobId,
    operation: 'create',
    outcome: 'succeeded',
    externalRef,
    detailPath: landed,
    failureReason: null,
    durationMs: Date.now() - startedAt,
  };
}

/* -------------------------------------------------------------------------------- revert ---- */

async function revert(
  job: Extract<UiSeedJob, { operation: 'revert' }>,
  context: JobContext,
  page: Page,
  startedAt: number,
): Promise<UiSeedResult> {
  const recordUrl = await context.policy.assertAllowed(job.detailPath, context.application.baseUrl);
  const flowUrl = await context.policy.assertAllowed(
    context.entryPath,
    context.application.baseUrl,
  );

  // Gone already is a revert with nothing to do, and the ledger's post-condition — that the
  // record does not exist — already holds. Reported as success rather than as a failure the
  // tester would have to interpret.
  if (await isGone(page, recordUrl.href)) {
    return reverted(job, startedAt);
  }

  const target = context.targets[0];
  if (target === undefined) {
    return failed(job, startedAt, 'the revert job named no delete control');
  }

  await page.goto(flowUrl.href, { waitUntil: 'networkidle' });

  const control = await locateRecord(page, target, job.detailPath);
  if (control.marker === null) {
    return failed(
      job,
      startedAt,
      control.reason ??
        `the delete control ${job.flow} is no longer on ${context.entryPath}, so ${job.externalRef} ` +
          'has to be removed by hand',
    );
  }

  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.locator(markerSelector(control.marker)).click(),
  ]);

  // Verification is a re-read of the record's own page, not an inference from where the delete
  // landed. An application that returns to the list on success and re-renders it on failure looks
  // identical from here until you go back and look.
  if (await isGone(page, recordUrl.href)) {
    return reverted(job, startedAt);
  }

  return failed(
    job,
    startedAt,
    `${job.externalRef} is still reachable at ${job.detailPath} after the delete flow ran`,
  );
}

/**
 * Whether the record's own page is gone.
 *
 * A 404 is the unambiguous answer and the common one. An application that soft-deletes and keeps
 * serving the page is not something this can detect, and it must not pretend otherwise — the
 * revert is reported as failed, and a tester who knows their application soft-deletes can read
 * that as "the row is flagged, not removed", which is true and is more than a green tick would
 * have told them.
 */
async function isGone(page: Page, url: string): Promise<boolean> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  return response !== null && response.status() === 404;
}

/* --------------------------------------------------------------------------------- shared --- */

/** Locate the job's controls in the current page, stamping each with a marker. */
async function locate(page: Page, targets: readonly SeedTarget[]): Promise<SeedLocateResult> {
  return page.evaluate<SeedLocateResult, SeedLocateOptions>(
    (options) =>
      (globalThis as unknown as { __wisprIndexer: InjectedBundle }).__wisprIndexer.locateControls(
        options,
      ),
    {
      targets,
      viewport: SEED_VIEWPORT,
      markerAttribute: SEED_MARKER_ATTRIBUTE,
      threshold: CONTROL_MATCH_THRESHOLD,
    },
  );
}

/** Locate this record's own copy of a repeated control — see `locateRecordControl`. */
async function locateRecord(
  page: Page,
  target: SeedTarget,
  detailPath: string,
): Promise<RecordControlLocation> {
  return page.evaluate<RecordControlLocation, RecordControlOptions>(
    (options) =>
      (
        globalThis as unknown as { __wisprIndexer: InjectedBundle }
      ).__wisprIndexer.locateRecordControl(options),
    {
      target,
      detailPath,
      viewport: SEED_VIEWPORT,
      markerAttribute: SEED_MARKER_ATTRIBUTE,
      marker: RECORD_CONTROL_MARKER,
      threshold: CONTROL_MATCH_THRESHOLD,
    },
  );
}

/**
 * Put one composed value into one located control.
 *
 * Playwright's own input methods rather than assigning `.value`: they dispatch the events a
 * framework listens for, and a React-controlled input assigned directly reverts on the next
 * render. Returns the failure sentence, or null.
 */
async function fill(page: Page, control: LocatedControl, value: unknown): Promise<string | null> {
  const locator = page.locator(markerSelector(control.marker));

  try {
    switch (control.kind) {
      case 'select':
        await locator.selectOption(String(value));
        return null;
      case 'checkbox':
        await locator.setChecked(value === true || value === 'true');
        return null;
      case 'radio':
        if (value === true || value === 'true') await locator.check();
        return null;
      case 'file':
        return `${control.field} is a file input, which the UI adapter cannot fill`;
      case 'editable':
        await locator.fill(stringify(value));
        return null;
    }
  } catch (error: unknown) {
    return `${control.field} could not be set: ${describe(error)}`;
  }
}

/**
 * A composed value as the form expects to receive it.
 *
 * Dates are the case that matters. The solver back-dates a `due_date` to satisfy an "overdue"
 * predicate and expresses it as an ISO timestamp, but `<input type="date">` accepts only the
 * date half and silently rejects the rest — which surfaces as an empty required field and a
 * form that will not submit, three steps away from the cause.
 */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const timestamp = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/.exec(value);
    return timestamp?.[1] ?? value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function markerSelector(marker: number): string {
  return `[${SEED_MARKER_ATTRIBUTE}="${String(marker)}"]`;
}

/**
 * The identifier the application gave the new record, read off the route it landed on.
 *
 * `toRoutePattern` already knows what an identifier segment looks like — it is the same
 * generalisation that turns `/orders/1841` into `/orders/:id` during indexing — so this asks it
 * rather than inventing a second notion of one. Reusing it also means the two cannot disagree
 * about a route the crawler generalised and the adapter did not.
 */
function identifierSegment(path: string): string | null {
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

/**
 * The page to open in order to reach a record's delete control.
 *
 * Two shapes, and the route pattern says which. A control indexed on `/orders/:id` is on the
 * record's own page, so the record's path *is* the page — no substitution, because the path was
 * read back from the application when the record was created and needs no reconstructing. A
 * control indexed on `/orders` is a list-row control, so the page is the list, and
 * `locateRecordControl` picks the right row once it is open.
 *
 * A pattern with more than one dynamic segment is refused. Reconstructing it would mean guessing
 * which slot the record fills, and guessing wrong navigates to somebody else's record and deletes
 * that instead.
 */
function flowPath(routePattern: string, detailPath: string): string {
  const dynamic = routePattern.split('/').filter((segment) => segment.startsWith(':'));

  if (dynamic.length === 0) return routePattern;
  if (dynamic.length === 1) return detailPath;

  throw new SeedError(
    `the delete flow was indexed on ${routePattern}, which carries ${String(dynamic.length)} ` +
      'identifiers — the page holding it cannot be addressed unambiguously',
  );
}

function element(
  elements: Map<string, { fingerprint: SeedTarget['fingerprint']; routePattern: string }>,
  key: string,
): { fingerprint: SeedTarget['fingerprint']; routePattern: string } {
  const found = elements.get(key);
  // Unreachable: `loadContext` refuses the job when a key is absent. Checked rather than asserted
  // because the alternative is a fingerprint of `undefined` matching nothing, reported as a form
  // that moved.
  if (found === undefined) throw new SeedError(`no indexed element for ${key}`);
  return found;
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    throw new SeedError(`the application's base URL is not a URL: ${baseUrl}`);
  }
}

function describeMissing(located: SeedLocateResult): string {
  const fields = located.missing.map((control) => control.field);
  return (
    `the create form no longer holds ${fields.join(', ')} — the application has changed since it ` +
    'was indexed, and this record needs a re-index before it can be seeded through the UI'
  );
}

function listFields(controls: readonly LocatedControl[]): string {
  return controls.map((control) => control.field).join(', ');
}

function failed(job: UiSeedJob, startedAt: number, reason: string): UiSeedResult {
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

function reverted(job: UiSeedJob, startedAt: number): UiSeedResult {
  return {
    jobId: job.jobId,
    operation: 'revert',
    outcome: 'succeeded',
    externalRef: null,
    detailPath: null,
    failureReason: null,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Bound the whole job, not each navigation.
 *
 * Playwright's per-action timeouts add up: a form with twelve controls could spend twelve
 * navigation timeouts failing slowly, long after the gateway gave up waiting for a result and the
 * tester saw an error. One ceiling over the whole job is what the gateway's own wait is sized
 * against.
 */
async function withDeadline(
  deadlineMs: number,
  work: Promise<UiSeedResult>,
  onTimeout: () => UiSeedResult,
): Promise<UiSeedResult> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<UiSeedResult>((resolve) => {
    timer = setTimeout(() => {
      resolve(onTimeout());
    }, deadlineMs);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function defaultAddressLookup(hostname: string): Promise<readonly string[]> {
  const { lookup } = await import('node:dns/promises');
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

function describe(error: unknown): string {
  if (error instanceof SeedError) return error.message;
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return 'unknown error';
}
