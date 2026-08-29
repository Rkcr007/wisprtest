import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { SessionTimeline } from 'protocol';
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

    return <SessionTimelineView timeline={timeline} />;
  } catch (error: unknown) {
    if (isAuthRequired(error) || (error instanceof ConsoleError && error.code === 'auth_required')) {
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
