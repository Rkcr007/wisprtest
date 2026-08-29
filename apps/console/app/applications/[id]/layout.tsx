import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { currentSession } from '../../../src/auth/current';

export const dynamic = 'force-dynamic';

/**
 * Every application screen shares one gate: a signed-in session.
 *
 * The masthead nav is in the root layout (it reads the pathname). This layout only keeps an
 * unauthenticated visitor from landing on a shell that would immediately 401 its BFF.
 */
export default async function ApplicationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await currentSession();
  if (session === null) {
    redirect(`/auth/login?next=${encodeURIComponent(`/applications/${id}`)}`);
  }
  return children;
}
