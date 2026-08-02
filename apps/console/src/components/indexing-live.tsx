'use client';

import { useEffect } from 'react';

import { completionRatio, type IndexProgressState } from '../indexing/progress';
import { useProgressStore } from '../indexing/store';
import { subscribeToProgress } from '../indexing/stream';
import { SkeletonChips, SkeletonRow } from './skeleton';

/**
 * Indexing — one crawl, live.
 *
 * The only client-fetching screen in the console, and it is the exception Phase 18 allows: a
 * Server Component cannot subscribe to an event stream. Everything else about the page is
 * rendered on the server.
 *
 * The store is a module singleton, which on the server would be shared between requests — so
 * nothing writes to it during render. It is populated from the effect below, which runs only in
 * the browser, and the server therefore always renders the same empty skeleton.
 */
export function IndexingLive({
  applicationId,
  jobId,
  pageCap,
}: {
  applicationId: string;
  jobId: string | null;
  pageCap: number | null;
}) {
  const progress = useProgressStore((store) => store.progress);
  const connected = useProgressStore((store) => store.connected);
  const warnings = useProgressStore((store) => store.warnings);

  useEffect(() => {
    const store = useProgressStore.getState();
    store.reset();

    const query = jobId === null ? '' : `?jobId=${encodeURIComponent(jobId)}`;
    return subscribeToProgress(`/api/applications/${applicationId}/index-progress${query}`, {
      onEvent: (event) => {
        useProgressStore.getState().apply(event);
      },
      onOpen: () => {
        useProgressStore.getState().markOpen();
      },
      onEnd: () => {
        // The job reached a terminal event; the gateway closed the stream deliberately. The
        // phase is already `completed` or `failed` from that event, so there is nothing to say.
      },
      onStreamError: () => {
        useProgressStore.getState().markStreamError();
      },
      onDisconnected: () => {
        useProgressStore.getState().markDisconnected();
      },
      onMalformed: (detail) => {
        useProgressStore.getState().warn(detail);
      },
    });
  }, [applicationId, jobId]);

  const ratio = completionRatio(progress, pageCap);
  const waiting = progress.phase === 'connecting';

  return (
    <>
      <section className="card" aria-labelledby="indexing-status">
        <h2 id="indexing-status">{headline(progress, connected)}</h2>

        <div
          className={barClass(progress, ratio)}
          role="progressbar"
          aria-label="Indexing progress"
          aria-valuetext={valueText(progress, ratio, pageCap)}
          {...(ratio === null
            ? {}
            : {
                'aria-valuenow': Math.round(ratio * 100),
                'aria-valuemin': 0,
                'aria-valuemax': 100,
              })}
        >
          <span
            className="fill"
            style={ratio === null ? undefined : { width: `${String(ratio * 100)}%` }}
          />
        </div>
        <p className="hint">{valueText(progress, ratio, pageCap)}</p>

        {waiting ? (
          <SkeletonChips count={4} />
        ) : (
          <div className="chips">
            <Chip tone="commit" label="Routes indexed" value={progress.routesIndexed} />
            <Chip tone="memory" label="Elements" value={progress.elementCount} />
            <Chip tone="memory" label="Navigation edges" value={progress.edgeCount} />
            <Chip tone="signal" label="Routes skipped" value={progress.routesSkipped} />
          </div>
        )}

        <dl className="grid">
          <Detail label="Memory version" value={versionLabel(progress)} />
          <Detail label="Job" value={progress.jobId ?? '—'} />
          <Detail
            label="Duration"
            value={progress.totalDurationMs === null ? '—' : formatMs(progress.totalDurationMs)}
          />
        </dl>

        {progress.failure === null ? null : (
          <p className="error" role="alert">
            The crawl failed: {progress.failure.code} — {progress.failure.detail}
          </p>
        )}
        {progress.sequenceGap ? (
          <p className="hint">
            A gap in the event sequence was detected: some progress events were not delivered. The
            counters below may undercount until the job reports its totals.
          </p>
        ) : null}
        {warnings.map((warning, index) => (
          <p className="hint" key={index}>
            {warning}
          </p>
        ))}

        {/*
          One polite live region carries the state changes. The tables update far too often to be
          announced row by row — a screen reader reading out two hundred routes is not progress,
          it is noise.
        */}
        <p className="visually-hidden" role="status">
          {headline(progress, connected)}. {valueText(progress, ratio, pageCap)}
        </p>
      </section>

      <section className="card" aria-labelledby="indexing-routes">
        <h2 id="indexing-routes">Routes</h2>
        <div className="scroll">
          <table>
            <caption>
              Discovered in crawl order. A route is listed the moment the crawler navigates to it.
            </caption>
            <thead>
              <tr>
                <th scope="col">Path</th>
                <th scope="col">Pattern</th>
                <th scope="col">State</th>
                <th scope="col" className="numeric">
                  Elements
                </th>
                <th scope="col" className="numeric">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {waiting ? (
                <>
                  <SkeletonRow widths={['70%', '55%', '40%', '30%', '30%']} />
                  <SkeletonRow widths={['60%', '65%', '40%', '30%', '30%']} />
                  <SkeletonRow widths={['80%', '45%', '40%', '30%', '30%']} />
                </>
              ) : progress.routes.length === 0 ? (
                <tr>
                  <td colSpan={5} className="hint">
                    No routes yet.
                  </td>
                </tr>
              ) : (
                progress.routes.map((route, index) => (
                  <tr key={`${String(index)}-${route.at}`}>
                    <td className="path">{route.path ?? '—'}</td>
                    <td className="path">{route.routePattern ?? '—'}</td>
                    <td className={`status-${route.status}`}>
                      {route.status === 'skipped' && route.skipReason !== null
                        ? `skipped — ${route.skipReason.replaceAll('_', ' ')}`
                        : route.status}
                    </td>
                    <td className="numeric">{route.elementCount ?? '—'}</td>
                    <td className="numeric">
                      {route.durationMs === null ? '—' : formatMs(route.durationMs)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="indexing-edges">
        <h2 id="indexing-edges">Navigation edges</h2>
        <div className="scroll">
          <table>
            <caption>
              Workflows are observed, not declared: each edge is a control the crawler clicked that
              moved it from one screen to another.
            </caption>
            <thead>
              <tr>
                <th scope="col">Trigger</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col" className="numeric">
                  Confidence
                </th>
              </tr>
            </thead>
            <tbody>
              {waiting ? (
                <>
                  <SkeletonRow widths={['65%', '50%', '50%', '30%']} />
                  <SkeletonRow widths={['55%', '50%', '50%', '30%']} />
                </>
              ) : progress.edges.length === 0 ? (
                <tr>
                  <td colSpan={4} className="hint">
                    No edges yet.
                  </td>
                </tr>
              ) : (
                progress.edges.map((edge, index) => (
                  <tr key={`${String(index)}-${edge.at}`}>
                    <td className="path">{edge.triggerElementKey}</td>
                    <td className="path">{edge.fromScreenId.slice(0, 8)}</td>
                    <td className="path">{edge.toScreenId.slice(0, 8)}</td>
                    <td className="numeric">{edge.confidence.toFixed(2)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Chip({
  tone,
  label,
  value,
}: {
  tone: 'signal' | 'commit' | 'memory' | 'drift';
  label: string;
  value: number;
}) {
  return (
    <span className={`chip ${tone}`}>
      <span className="value">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <dt>
        <label>{label}</label>
      </dt>
      <dd className="path" style={{ margin: 0 }}>
        {value}
      </dd>
    </div>
  );
}

function headline(progress: IndexProgressState, connected: boolean): string {
  switch (progress.phase) {
    case 'connecting':
      return 'Connecting to the progress stream';
    case 'running':
      return connected ? 'Indexing' : 'Indexing — reconnecting';
    case 'completed':
      return 'Index complete';
    case 'failed':
      return 'Index failed';
    case 'stream_error':
      return 'The progress stream stopped';
  }
}

function barClass(progress: IndexProgressState, ratio: number | null): string {
  if (progress.phase === 'failed' || progress.phase === 'stream_error') return 'bar failed';
  if (progress.phase === 'completed') return 'bar done';
  return ratio === null ? 'bar indeterminate' : 'bar';
}

function valueText(
  progress: IndexProgressState,
  ratio: number | null,
  pageCap: number | null,
): string {
  const seen = progress.routesIndexed + progress.routesSkipped;

  if (progress.phase === 'completed') {
    return `${String(progress.routesIndexed)} screens, ${String(progress.elementCount)} elements, ${String(progress.edgeCount)} edges`;
  }
  if (ratio === null || pageCap === null) {
    return `${String(seen)} routes seen — no page cap in this URL, so the bar cannot show a proportion`;
  }
  return `${String(seen)} of at most ${String(pageCap)} routes`;
}

function versionLabel(progress: IndexProgressState): string {
  if (progress.version === null) return '—';
  return `v${String(progress.version)}${progress.resumed ? ' (resumed)' : ''}`;
}

/** Milliseconds, rendered the way a tester reads them rather than to the microsecond. */
function formatMs(value: number): string {
  if (value < 1000) return `${String(Math.round(value))} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}
