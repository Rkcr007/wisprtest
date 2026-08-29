import { Suspense } from 'react';

import { DataPanel } from '../../../../src/components/data-panel';
import { callGatewayJson } from '../../../../src/gateway/client';
import { requireApplicationPage, redirectIfAuth } from '../../../../src/http/application-page';
import { pageLoadMessage } from '../../../../src/http/page-load';
import { ApplicationSchemas, SessionLedger, SessionList } from '../../../../src/memory/schema';

export const dynamic = 'force-dynamic';

/**
 * Data — learned schemas and the seed ledger of the latest session.
 */
export default async function DataPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <section className="card" aria-busy="true">
          <h2>Data</h2>
          <p className="visually-hidden" role="status">
            Loading schemas
          </p>
        </section>
      }
    >
      <DataLoaded applicationId={id} />
    </Suspense>
  );
}

async function DataLoaded({ applicationId }: { applicationId: string }) {
  const next = `/applications/${applicationId}/data`;
  const loaded = await requireApplicationPage(applicationId, next);
  if (!loaded.ok) {
    return (
      <section className="card">
        <h2>Data</h2>
        <p className="error" role="alert">
          {loaded.error}
        </p>
      </section>
    );
  }

  try {
    const [schemas, sessions] = await Promise.all([
      callGatewayJson(
        loaded.session,
        { method: 'GET', path: `/v1/applications/${loaded.applicationId}/schemas` },
        ApplicationSchemas,
      ),
      callGatewayJson(
        loaded.session,
        { method: 'GET', path: `/v1/sessions?applicationId=${loaded.applicationId}&limit=1` },
        SessionList,
      ),
    ]);
    const latest = sessions.sessions[0];
    const ledger =
      latest === undefined
        ? { sessionId: null, entries: [] }
        : await callGatewayJson(
            loaded.session,
            { method: 'GET', path: `/v1/sessions/${latest.id}/ledger` },
            SessionLedger,
          );
    return (
      <DataPanel
        applicationId={loaded.applicationId}
        schemas={schemas.schemas}
        memoryVersionId={schemas.memoryVersionId}
        sessionId={ledger.sessionId}
        entries={ledger.entries}
      />
    );
  } catch (error: unknown) {
    redirectIfAuth(error, next);
    return (
      <section className="card">
        <h2>Data</h2>
        <p className="error" role="alert">
          {pageLoadMessage(error, 'the console could not load data')}
        </p>
      </section>
    );
  }
}
