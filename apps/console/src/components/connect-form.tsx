'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { z } from 'zod';

import {
  initialCrawlForm,
  issuesFromGateway,
  parseCrawlForm,
  type CrawlFormIssues,
  type CrawlFormValues,
} from '../crawl/form';
import { StartCrawlResponse, type StartCrawlRequest } from '../crawl/request';
import { NumberField, SelectField, TextAreaField, TextField } from './field';

/**
 * Connect — name an application, bound the crawl, start indexing.
 *
 * The whole screen exists to make the gateway's refusal unnecessary: `POST
 * /v1/applications/:id/crawl` rejects a request whose bounds are incomplete, and this form is
 * where those bounds are decided, in the same order of importance the crawl route reasons about
 * them — where it may go, how far, how much, and what it must never touch.
 */

/** What the console's own crawl route answers with when it refuses. */
const ConsoleRouteError = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).default([]),
});

interface StartedJob {
  /** Identity before the gateway has given us one, so the optimistic row can be replaced. */
  readonly clientId: string;
  readonly applicationId: string;
  readonly jobId: string | null;
  readonly pageCap: number;
  readonly at: string;
  readonly status: 'starting' | 'queued';
}

const STARTED_JOBS = ['started-jobs'] as const;

export function ConnectForm() {
  const router = useRouter();
  const client = useQueryClient();
  const prefix = useId();
  const [values, setValues] = useState<CrawlFormValues>(initialCrawlForm);
  const [issues, setIssues] = useState<CrawlFormIssues>({});

  const field = (name: string): string => `${prefix}-${name}`;
  const set = <K extends keyof CrawlFormValues>(key: K, value: CrawlFormValues[K]): void => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  /**
   * The jobs started from this browser, in this session.
   *
   * Not "recently worked on": that list needs memory versions, screen and element counts and an
   * index age, and the gateway exposes no route that returns them (there is no
   * `GET /v1/applications`). Rather than invent the shape or fill a table from a guess, this shows
   * only what this console itself did, which it can vouch for.
   */
  const started = useQuery<StartedJob[]>({
    queryKey: STARTED_JOBS,
    queryFn: () => [],
    initialData: [],
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const startCrawl = useMutation<
    StartCrawlResponse,
    Error,
    { applicationId: string; request: StartCrawlRequest; clientId: string },
    { previous: StartedJob[] }
  >({
    mutationFn: async ({ applicationId, request }) => {
      const response = await fetch(`/api/applications/${applicationId}/crawl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const failure = ConsoleRouteError.safeParse(payload);
        if (failure.success) {
          setIssues((current) => ({ ...current, ...issuesFromGateway(failure.data.issues) }));
          throw new Error(failure.data.message);
        }
        throw new Error(`the console could not start the crawl (HTTP ${String(response.status)})`);
      }

      const parsed = StartCrawlResponse.safeParse(payload);
      if (!parsed.success) throw new Error('the gateway returned an unrecognised job');
      return parsed.data;
    },

    // Optimistic: the row appears the moment the request leaves, marked "starting".
    onMutate: ({ applicationId, request, clientId }) => {
      const previous = client.getQueryData<StartedJob[]>(STARTED_JOBS) ?? [];
      client.setQueryData<StartedJob[]>(STARTED_JOBS, [
        {
          clientId,
          applicationId,
          jobId: null,
          pageCap: request.bounds.maxPages,
          at: new Date().toISOString(),
          status: 'starting',
        },
        ...previous,
      ]);
      return { previous };
    },

    // Rollback. A crawl that was refused must leave nothing behind suggesting one is running.
    onError: (_error, _variables, context) => {
      if (context !== undefined) client.setQueryData<StartedJob[]>(STARTED_JOBS, context.previous);
    },

    onSuccess: (job, { clientId }) => {
      client.setQueryData<StartedJob[]>(STARTED_JOBS, (current) =>
        (current ?? []).map((entry) =>
          entry.clientId === clientId ? { ...entry, jobId: job.jobId, status: 'queued' } : entry,
        ),
      );
      router.push(progressHref(job.applicationId, job.jobId, pageCapOf(client, clientId)));
    },
  });

  const submit = (event: React.SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = parseCrawlForm(values);

    if (!parsed.ok) {
      setIssues(parsed.issues);
      return;
    }

    setIssues({});
    startCrawl.mutate({
      applicationId: parsed.applicationId,
      request: parsed.request,
      clientId: crypto.randomUUID(),
    });
  };

  const busy = startCrawl.isPending;

  return (
    <>
      <form className="card" onSubmit={submit} noValidate>
        <h2>Start an index</h2>
        <p className="hint">
          The crawl runs a real browser against the application under the auth profile you name
          here. Everything it is allowed to do is on this form; the gateway refuses a crawl whose
          bounds are incomplete.
        </p>

        <TextField
          id={field('applicationId')}
          label="Application"
          value={values.applicationId}
          onChange={(value) => {
            set('applicationId', value);
          }}
          error={issues.applicationId}
          placeholder="00000000-0000-0000-0000-000000000000"
          hint="The registered application's UUID. The crawl starts at the base URL held on that record — the gateway does not accept a start URL on the request."
        />

        <h3>Bounds</h3>
        <TextAreaField
          id={field('allowedOrigins')}
          label="Allowed origins"
          value={values.allowedOrigins}
          onChange={(value) => {
            set('allowedOrigins', value);
          }}
          error={issues.allowedOrigins}
          placeholder={'https://app.example.com'}
          hint="One absolute URL per line. Must include the origin the application is registered at; a link anywhere else is recorded as skipped, never followed."
        />
        <TextAreaField
          id={field('routeAllowlist')}
          label="Route allowlist"
          value={values.routeAllowlist}
          onChange={(value) => {
            set('routeAllowlist', value);
          }}
          error={issues.routeAllowlist}
          placeholder={'/orders\n/settings'}
          hint="Path prefixes the crawl may enter, one per line. A single / permits the whole application."
        />

        <div className="grid">
          <NumberField
            id={field('maxDepth')}
            label="Depth cap"
            value={values.maxDepth}
            onChange={(value) => {
              set('maxDepth', value);
            }}
            error={issues.maxDepth}
            hint="Links from the base URL. 0 indexes the entry route alone."
          />
          <NumberField
            id={field('maxPages')}
            label="Page cap"
            value={values.maxPages}
            onChange={(value) => {
              set('maxPages', value);
            }}
            error={issues.maxPages}
            hint="Hard ceiling on screens indexed, whatever the depth allows."
          />
        </div>

        <TextAreaField
          id={field('neverInteractSelectors')}
          label="Never interact with"
          value={values.neverInteractSelectors}
          onChange={(value) => {
            set('neverInteractSelectors', value);
          }}
          error={issues.neverInteractSelectors}
          placeholder={'button[data-action="delete"]\n.danger-zone button'}
          hint="CSS selectors the crawl must never click, one per line. Evaluated before any interaction."
        />
        <label className="radio-row">
          <input
            type="checkbox"
            checked={values.noDestructiveControls}
            onChange={(event) => {
              set('noDestructiveControls', event.target.checked);
            }}
          />
          <span>This application has no destructive controls to exclude.</span>
        </label>

        <details>
          <summary>Timing, rate and viewport</summary>
          <div className="grid">
            <NumberField
              id={field('requestsPerMinute')}
              label="Navigations per minute"
              value={values.requestsPerMinute}
              onChange={(value) => {
                set('requestsPerMinute', value);
              }}
              error={issues.requestsPerMinute}
              hint="The crawl is a load test nobody asked for unless it is throttled."
            />
            <NumberField
              id={field('maxInteractionsPerRoute')}
              label="Interactions per screen"
              value={values.maxInteractionsPerRoute}
              onChange={(value) => {
                set('maxInteractionsPerRoute', value);
              }}
              error={issues.maxInteractionsPerRoute}
              hint="Clicks attempted while deriving navigation edges. 0 indexes elements only."
            />
            <NumberField
              id={field('interactionObserveMs')}
              label="Interaction observe (ms)"
              value={values.interactionObserveMs}
              onChange={(value) => {
                set('interactionObserveMs', value);
              }}
              error={issues.interactionObserveMs}
            />
            <NumberField
              id={field('settleDelayMs')}
              label="Settle delay (ms)"
              value={values.settleDelayMs}
              onChange={(value) => {
                set('settleDelayMs', value);
              }}
              error={issues.settleDelayMs}
            />
            <NumberField
              id={field('networkIdleTimeoutMs')}
              label="Network idle timeout (ms)"
              value={values.networkIdleTimeoutMs}
              onChange={(value) => {
                set('networkIdleTimeoutMs', value);
              }}
              error={issues.networkIdleTimeoutMs}
            />
            <NumberField
              id={field('navigationTimeoutMs')}
              label="Navigation timeout (ms)"
              value={values.navigationTimeoutMs}
              onChange={(value) => {
                set('navigationTimeoutMs', value);
              }}
              error={issues.navigationTimeoutMs}
            />
            <NumberField
              id={field('viewportWidth')}
              label="Viewport width"
              value={values.viewportWidth}
              onChange={(value) => {
                set('viewportWidth', value);
              }}
              error={issues.viewportWidth}
            />
            <NumberField
              id={field('viewportHeight')}
              label="Viewport height"
              value={values.viewportHeight}
              onChange={(value) => {
                set('viewportHeight', value);
              }}
              error={issues.viewportHeight}
            />
          </div>
        </details>

        <fieldset>
          <legend>Authentication</legend>
          <SelectField
            id={field('authKind')}
            label="Profile"
            value={values.authKind}
            options={[
              { value: 'none', label: 'None — the application crawls unauthenticated' },
              { value: 'form', label: 'Form login' },
              { value: 'storage_state', label: 'Captured browser state' },
            ]}
            onChange={(value) => {
              set('authKind', value);
            }}
          />

          {values.authKind === 'form' ? (
            <div className="grid">
              <TextField
                id={field('loginPath')}
                label="Login path"
                value={values.loginPath}
                onChange={(value) => {
                  set('loginPath', value);
                }}
                error={issues.loginPath}
                placeholder="/login"
              />
              <TextField
                id={field('successPath')}
                label="Success path"
                value={values.successPath}
                onChange={(value) => {
                  set('successPath', value);
                }}
                error={issues.successPath}
                placeholder="/dashboard"
              />
              <TextField
                id={field('usernameLabel')}
                label="Username control"
                value={values.usernameLabel}
                onChange={(value) => {
                  set('usernameLabel', value);
                }}
                error={issues.usernameLabel}
                placeholder="Email address"
                hint="Accessible name, not a selector."
              />
              <TextField
                id={field('passwordLabel')}
                label="Password control"
                value={values.passwordLabel}
                onChange={(value) => {
                  set('passwordLabel', value);
                }}
                error={issues.passwordLabel}
                placeholder="Password"
              />
              <TextField
                id={field('submitLabel')}
                label="Submit control"
                value={values.submitLabel}
                onChange={(value) => {
                  set('submitLabel', value);
                }}
                error={issues.submitLabel}
                placeholder="Sign in"
              />
              <SelectField
                id={field('credentialsProvider')}
                label="Credentials held in"
                value={values.credentialsProvider}
                options={[
                  { value: 'env', label: 'Environment variable' },
                  { value: 'file', label: 'File' },
                ]}
                onChange={(value) => {
                  set('credentialsProvider', value);
                }}
              />
              <TextField
                id={field('credentialsKey')}
                label="Credentials reference"
                value={values.credentialsKey}
                onChange={(value) => {
                  set('credentialsKey', value);
                }}
                error={issues.credentialsKey}
                placeholder="NORTHSTAR_CRAWL_CREDENTIALS"
                hint="A pointer to where the username and password live. WisprTest never stores them."
              />
            </div>
          ) : null}

          {values.authKind === 'storage_state' ? (
            <div className="grid">
              <SelectField
                id={field('stateProvider')}
                label="Storage state held in"
                value={values.stateProvider}
                options={[
                  { value: 'env', label: 'Environment variable' },
                  { value: 'file', label: 'File' },
                ]}
                onChange={(value) => {
                  set('stateProvider', value);
                }}
              />
              <TextField
                id={field('stateKey')}
                label="Storage state reference"
                value={values.stateKey}
                onChange={(value) => {
                  set('stateKey', value);
                }}
                error={issues.stateKey}
                placeholder="/var/run/secrets/northstar-state.json"
                hint="The blob holds live session cookies, so it is referenced and never pasted here."
              />
            </div>
          ) : null}
        </fieldset>

        {issues.form === undefined ? null : (
          <p className="error" role="alert">
            {issues.form}
          </p>
        )}
        {startCrawl.isError ? (
          <p className="error" role="alert">
            {startCrawl.error.message}
          </p>
        ) : null}

        <div>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Starting index…' : 'Start index'}
          </button>
        </div>
      </form>

      <section className="card" aria-labelledby={field('started-heading')}>
        <h2 id={field('started-heading')}>Started from this browser</h2>
        {started.data.length === 0 ? (
          <p className="hint">
            No crawls started here yet. A list of recently-worked-on applications — memory version,
            screen and element counts, index age — needs a route the gateway does not expose yet
            (there is no <code>GET /v1/applications</code>), so this shows only what this console
            has itself started.
          </p>
        ) : (
          <table>
            <caption>Jobs this browser enqueued, newest first.</caption>
            <thead>
              <tr>
                <th scope="col">Application</th>
                <th scope="col">Job</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {started.data.map((job) => (
                <tr key={job.clientId}>
                  <td className="path">{job.applicationId}</td>
                  <td className="path">
                    {job.jobId === null ? (
                      <span className="status-crawling">starting…</span>
                    ) : (
                      <a href={progressHref(job.applicationId, job.jobId, job.pageCap)}>
                        {job.jobId}
                      </a>
                    )}
                  </td>
                  <td>{new Date(job.at).toISOString().replace('T', ' ').slice(0, 19)}Z</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/**
 * The Indexing screen's URL.
 *
 * The page cap travels in the query string because the progress stream does not carry it and the
 * bar needs a denominator that is true. It is the number the tester just typed, not an estimate.
 */
function progressHref(applicationId: string, jobId: string, pageCap: number): string {
  return `/applications/${applicationId}/indexing?jobId=${jobId}&pageCap=${String(pageCap)}`;
}

function pageCapOf(client: ReturnType<typeof useQueryClient>, clientId: string): number {
  const jobs = client.getQueryData<StartedJob[]>(STARTED_JOBS) ?? [];
  return jobs.find((job) => job.clientId === clientId)?.pageCap ?? 0;
}
