import { Suspense } from 'react';

import { SessionsList } from '../../../../src/components/sessions-list';
import { SessionTimelineSkeleton } from '../../../../src/components/skeleton';
import { callGatewayJson } from '../../../../src/gateway/client';
import { requireApplicationPage, redirectIfAuth } from '../../../../src/http/application-page';
import { pageLoadMessage } from '../../../../src/http/page-load';
import { SessionList } from '../../../../src/memory/schema';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/**
 * Session history for one application.
 */
export default async function SessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const rawOffset = typeof query.offset === 'string' ? Number(query.offset) : 0;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return (
    <Suspense fallback={<SessionTimelineSkeleton />}>
      <SessionsLoaded applicationId={id} offset={offset} />
    </Suspense>
  );
}

async function SessionsLoaded({
  applicationId,
  offset,
}: {
  applicationId: string;
  offset: number;
}) {
  const next = `/applications/${applicationId}/sessions`;
  const loaded = await requireApplicationPage(applicationId, next);
  if (!loaded.ok) {
    return (
      <section className="card">
        <h2>Sessions</h2>
        <p className="error" role="alert">
          {loaded.error}
        </p>
      </section>
    );
  }

  try {
    const listed = await callGatewayJson(
      loaded.session,
      {
        method: 'GET',
        path: `/v1/sessions?applicationId=${loaded.applicationId}&limit=${String(PAGE_SIZE)}&offset=${String(offset)}`,
      },
      SessionList,
    );
    return (
      <SessionsList
        applicationId={loaded.applicationId}
        listed={listed}
        offset={offset}
        limit={PAGE_SIZE}
      />
    );
  } catch (error: unknown) {
    redirectIfAuth(error, next);
    return (
      <section className="card">
        <h2>Sessions</h2>
        <p className="error" role="alert">
          {pageLoadMessage(error, 'the console could not load sessions')}
        </p>
      </section>
    );
  }
}
