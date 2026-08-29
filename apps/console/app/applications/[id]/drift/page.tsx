import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { DriftListResponse } from 'protocol';
import { z } from 'zod';

import { currentSession } from '../../../../src/auth/current';
import { DriftQueue } from '../../../../src/components/drift-queue';
import { DriftQueueSkeleton } from '../../../../src/components/skeleton';
import { ConsoleError } from '../../../../src/errors';
import { callGatewayJson } from '../../../../src/gateway/client';
import { isAuthRequired, pageLoadMessage } from '../../../../src/http/page-load';

export const dynamic = 'force-dynamic';

/**
 * Drift — pending reports with a reviewable diff and approve/reject.
 *
 * The queue is fetched on the server and handed to the client as `initialData` so the first
 * paint is the real list. Decisions go through `POST /api/drift/:id/approve` so the browser
 * never holds the OIDC token.
 */
export default async function DriftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<DriftQueueSkeleton />}>
      <DriftLoaded applicationId={id} />
    </Suspense>
  );
}

async function DriftLoaded({ applicationId }: { applicationId: string }) {
  const parsed = z.uuid().safeParse(applicationId);
  if (!parsed.success) {
    return (
      <section className="card">
        <h2>Drift</h2>
        <p className="error" role="alert">
          the application id is not a UUID
        </p>
      </section>
    );
  }

  const session = await currentSession();
  if (session === null) {
    redirect(`/auth/login?next=${encodeURIComponent(`/applications/${parsed.data}/drift`)}`);
  }

  try {
    const listed = await callGatewayJson(
      session,
      { method: 'GET', path: `/v1/drift/${parsed.data}` },
      DriftListResponse,
    );
    return <DriftQueue applicationId={parsed.data} initial={listed} />;
  } catch (error: unknown) {
    if (isAuthRequired(error) || (error instanceof ConsoleError && error.code === 'auth_required')) {
      redirect(`/auth/login?next=${encodeURIComponent(`/applications/${parsed.data}/drift`)}`);
    }
    return (
      <section className="card">
        <h2>Drift</h2>
        <p className="error" role="alert">
          {pageLoadMessage(error, 'the console could not load drift reports')}
        </p>
      </section>
    );
  }
}
