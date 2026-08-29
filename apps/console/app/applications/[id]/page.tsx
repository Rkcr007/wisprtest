import { Suspense } from 'react';

import { ApplicationRecord } from '../../../src/applications/schema';
import { Overview } from '../../../src/components/overview';
import { SkeletonChips } from '../../../src/components/skeleton';
import { callGatewayJson } from '../../../src/gateway/client';
import { requireApplicationPage, redirectIfAuth } from '../../../src/http/application-page';
import { pageLoadMessage } from '../../../src/http/page-load';
import { SessionList } from '../../../src/memory/schema';

export const dynamic = 'force-dynamic';

/**
 * Application overview — memory version, screen/element counts, open drift, recent sessions.
 */
export default async function OverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <section className="card" aria-busy="true">
          <h2>Overview</h2>
          <p className="visually-hidden" role="status">
            Loading overview
          </p>
          <SkeletonChips count={4} />
        </section>
      }
    >
      <OverviewLoaded applicationId={id} />
    </Suspense>
  );
}

async function OverviewLoaded({ applicationId }: { applicationId: string }) {
  const loaded = await requireApplicationPage(applicationId, `/applications/${applicationId}`);
  if (!loaded.ok) {
    return (
      <section className="card">
        <h2>Overview</h2>
        <p className="error" role="alert">
          {loaded.error}
        </p>
      </section>
    );
  }

  try {
    const [application, sessions] = await Promise.all([
      callGatewayJson(
        loaded.session,
        { method: 'GET', path: `/v1/applications/${loaded.applicationId}` },
        ApplicationRecord,
      ),
      callGatewayJson(
        loaded.session,
        {
          method: 'GET',
          path: `/v1/sessions?applicationId=${loaded.applicationId}&limit=5`,
        },
        SessionList,
      ),
    ]);
    return <Overview application={application} sessions={sessions} />;
  } catch (error: unknown) {
    redirectIfAuth(error, `/applications/${loaded.applicationId}`);
    return (
      <section className="card">
        <h2>Overview</h2>
        <p className="error" role="alert">
          {pageLoadMessage(error, 'the console could not load this application')}
        </p>
      </section>
    );
  }
}
