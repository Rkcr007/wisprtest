import { currentSession } from '../src/auth/current';
import { ConnectForm } from '../src/components/connect-form';

export const dynamic = 'force-dynamic';

/**
 * Connect — the console's entry point.
 *
 * A Server Component: the session is read on the server and the form is the only part that ships
 * as client code, so an unauthenticated visitor is never served the crawl form at all.
 *
 * Two of Phase 18's eight screens are built. There is no navigation here to the other six,
 * because a link to a route that does not exist is a worse answer than no link.
 */
export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  const params = await searchParams;
  const authError = typeof params.authError === 'string' ? params.authError : null;

  if (session === null) {
    return (
      <section className="card">
        <h2>Sign in</h2>
        <p className="hint">
          The console acts as you against the gateway: starting an index needs the{' '}
          <code>application:register</code> permission, which floors at the lead role. Sign in with
          your identity provider to continue.
        </p>
        {authError === null ? null : (
          <p className="error" role="alert">
            {authError}
          </p>
        )}
        <div>
          <a className="chip" href="/auth/login?next=/">
            Sign in
          </a>
        </div>
      </section>
    );
  }

  return (
    <>
      {authError === null ? null : (
        <p className="error" role="alert">
          {authError}
        </p>
      )}
      <ConnectForm />
    </>
  );
}
