'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * TanStack Query, for the one thing the console mutates: starting a crawl.
 *
 * The client is created in state rather than at module scope so it is per-request on the server —
 * a module-level client would be shared between every tenant's render, which is exactly the kind
 * of cross-tenant leak CLAUDE.md rule #7 exists to prevent.
 *
 * No retries. `POST /v1/applications/:id/crawl` enqueues a job; a request that timed out may well
 * have been accepted, and a silent retry would run the customer's application through two crawls.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          mutations: { retry: false },
          queries: { retry: false, staleTime: 30_000 },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
