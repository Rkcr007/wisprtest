import { redirect } from 'next/navigation';

import { currentSession } from '../../../../src/auth/current';
import { IndexingLive } from '../../../../src/components/indexing-live';

export const dynamic = 'force-dynamic';

/**
 * Indexing — watch one crawl.
 *
 * The shell is a Server Component and the live region is the only client code on the page. There
 * is nothing else to server-render: the gateway exposes no read of an application's name, base
 * URL or memory state, so everything on this screen comes from the event stream.
 *
 * An unauthenticated visitor is redirected to sign in and returned here afterwards, rather than
 * being shown a page whose stream would immediately 401.
 */
export default async function IndexingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  const session = await currentSession();
  if (session === null) {
    redirect(`/auth/login?next=${encodeURIComponent(`/applications/${id}/indexing`)}`);
  }

  const jobId = typeof query.jobId === 'string' && query.jobId !== '' ? query.jobId : null;
  const pageCap = parsePageCap(query.pageCap);

  return (
    <>
      <section className="card">
        <h2>Application {id}</h2>
        <p className="hint">
          {jobId === null
            ? 'Following this application’s most recent index job.'
            : `Following job ${jobId}.`}{' '}
          The stream replays what the job has already published, so opening this page part way
          through a crawl shows the routes indexed so far.
        </p>
        <div>
          <a href="/">Back to Connect</a>
        </div>
      </section>

      <IndexingLive applicationId={id} jobId={jobId} pageCap={pageCap} />
    </>
  );
}

/**
 * The page cap from the URL, or null.
 *
 * Written there by the Connect screen from the bound the tester submitted. Anything unparseable
 * is null, which leaves the progress bar indeterminate rather than scaled against a guess.
 */
function parsePageCap(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
