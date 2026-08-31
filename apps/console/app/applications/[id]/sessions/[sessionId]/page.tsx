import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { FalseExecutionReport, SessionTimeline } from 'protocol';
import { z } from 'zod';

import { currentSession } from '../../../../../src/auth/current';
import { SessionTimelineView } from '../../../../../src/components/session-timeline';
import { SessionTimelineSkeleton } from '../../../../../src/components/skeleton';
import { ConsoleError } from '../../../../../src/errors';
import { callGatewayJson } from '../../../../../src/gateway/client';
import { isAuthRequired, pageLoadMessage } from '../../../../../src/http/page-load';

export const dynamic = 'force-dynamic';

/**
 * Session detail — the step timeline and the signed evidence those steps reference.
 *
 * Fetched on the server from `GET /v1/sessions/:id`. The BFF at `/api/sessions/:sessionId`
 * exists so a later client refresh uses the same path the browser is allowed to call.
 *
 * The false-execution reports are fetched beside the timeline and seed the client cells in the
 * *False execution* column. They are an annotation on the evidence, not the evidence, so their
 * failure degrades to an empty column rather than to an error where the timeline should be —
 * the same rule that makes an unsigned evidence key read as "not signed" instead of a guess.
 */
export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id, sessionId } = await params;
  return (
    <Suspense fallback={<SessionTimelineSkeleton />}>
      <SessionLoaded applicationId={id} sessionId={sessionId} />
    </Suspense>
  );
}

async function SessionLoaded({
  applicationId,
  sessionId,
}: {
  applicationId: string;
  sessionId: string;
}) {
  const app = z.uuid().safeParse(applicationId);
  const sitting = z.uuid().safeParse(sessionId);
  if (!app.success || !sitting.success) {
    return (
      <section className="card">
        <h2>Session</h2>
        <p className="error" role="alert">
          {!app.success ? 'the application id is not a UUID' : 'the session id is not a UUID'}
        </p>
      </section>
    );
  }

  const next = `/applications/${app.data}/sessions/${sitting.data}`;
  const session = await currentSession();
  if (session === null) {
    redirect(`/auth/login?next=${encodeURIComponent(next)}`);
  }

  try {
    const timeline = await callGatewayJson(
      session,
      { method: 'GET', path: `/v1/sessions/${sitting.data}` },
      SessionTimeline,
    );

    if (timeline.session.applicationId !== app.data) {
      return (
        <section className="card">
          <h2>Session</h2>
          <p className="error" role="alert">
            This session does not belong to this application.
          </p>
        </section>
      );
    }

    const reports = await loadReports(session, sitting.data);

    return <SessionTimelineView timeline={timeline} reports={reports} />;
  } catch (error: unknown) {
    if (
      isAuthRequired(error) ||
      (error instanceof ConsoleError && error.code === 'auth_required')
    ) {
      redirect(`/auth/login?next=${encodeURIComponent(next)}`);
    }
    return (
      <section className="card">
        <h2>Session</h2>
        <p className="error" role="alert">
          {pageLoadMessage(error, 'the console could not load the session')}
        </p>
      </section>
    );
  }
}

const ReportList = z.array(FalseExecutionReport);

/**
 * The reports filed against this session, or none.
 *
 * Deliberately swallowing: a tenant whose reports cannot be read should still see what their
 * tester did. The column then offers Report, and the gateway refuses if the read failed for a
 * reason that will also refuse the write — which is the honest place for that sentence.
 */
async function loadReports(
  session: NonNullable<Awaited<ReturnType<typeof currentSession>>>,
  sessionId: string,
): Promise<readonly FalseExecutionReport[]> {
  try {
    return await callGatewayJson(
      session,
      { method: 'GET', path: `/v1/sessions/${sessionId}/false-executions` },
      ReportList,
    );
  } catch {
    return [];
  }
}
