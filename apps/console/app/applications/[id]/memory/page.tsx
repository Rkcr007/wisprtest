import { PendingScreen } from '../../../../src/components/pending-screen';

export const dynamic = 'force-dynamic';

/**
 * Product Memory — navigation graph, element registry, alias corpus.
 *
 * The snapshot the extension attaches with is not a console-readable graph endpoint yet.
 */
export default async function MemoryPage() {
  return (
    <PendingScreen
      title="Product Memory"
      from="GET /v1/memory/:appId (navigation graph, elements, aliases)"
    />
  );
}
