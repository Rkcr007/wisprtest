import { Suspense } from 'react';
import { z } from 'zod';

import { MemoryExplorer } from '../../../../src/components/memory-explorer';
import { callGatewayJson } from '../../../../src/gateway/client';
import { requireApplicationPage, redirectIfAuth } from '../../../../src/http/application-page';
import { pageLoadMessage } from '../../../../src/http/page-load';
import { AliasList, ElementList, GraphList, ScreenList } from '../../../../src/memory/schema';

export const dynamic = 'force-dynamic';

/**
 * Product Memory — screens, graph, elements, aliases of the active version.
 */
export default async function MemoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const rawScreen = query.screenId;
  const screenId = typeof rawScreen === 'string' ? rawScreen : null;
  return (
    <Suspense
      fallback={
        <section className="card" aria-busy="true">
          <h2>Memory</h2>
          <p className="visually-hidden" role="status">
            Loading product memory
          </p>
        </section>
      }
    >
      <MemoryLoaded applicationId={id} screenId={screenId} />
    </Suspense>
  );
}

async function MemoryLoaded({
  applicationId,
  screenId,
}: {
  applicationId: string;
  screenId: string | null;
}) {
  const next =
    screenId === null
      ? `/applications/${applicationId}/memory`
      : `/applications/${applicationId}/memory?screenId=${screenId}`;
  const loaded = await requireApplicationPage(applicationId, next);
  if (!loaded.ok) {
    return (
      <section className="card">
        <h2>Memory</h2>
        <p className="error" role="alert">
          {loaded.error}
        </p>
      </section>
    );
  }

  const scoped = screenId !== null && z.uuid().safeParse(screenId).success;
  const elementQuery = scoped ? `?screenId=${screenId}` : '';

  try {
    const [screens, elements, graph, aliases] = await Promise.all([
      callGatewayJson(
        loaded.session,
        { method: 'GET', path: `/v1/memory/${loaded.applicationId}/screens?limit=100` },
        ScreenList,
      ),
      callGatewayJson(
        loaded.session,
        { method: 'GET', path: `/v1/memory/${loaded.applicationId}/elements${elementQuery}` },
        ElementList,
      ),
      callGatewayJson(
        loaded.session,
        { method: 'GET', path: `/v1/memory/${loaded.applicationId}/graph` },
        GraphList,
      ),
      callGatewayJson(
        loaded.session,
        { method: 'GET', path: `/v1/memory/${loaded.applicationId}/aliases?limit=100` },
        AliasList,
      ),
    ]);
    return (
      <MemoryExplorer
        applicationId={loaded.applicationId}
        screens={screens}
        elements={elements}
        graph={graph}
        aliases={aliases}
        selectedScreenId={scoped ? screenId : null}
      />
    );
  } catch (error: unknown) {
    redirectIfAuth(error, next);
    return (
      <section className="card">
        <h2>Memory</h2>
        <p className="error" role="alert">
          {pageLoadMessage(error, 'the console could not load product memory')}
        </p>
      </section>
    );
  }
}
