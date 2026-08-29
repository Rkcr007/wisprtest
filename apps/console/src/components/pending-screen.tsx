/**
 * An application screen whose gateway read is not live yet.
 *
 * Not a stub of the screen: it is the destination the nav needs, and it says exactly why the
 * body is empty. Inventing coverage numbers, a navigation graph or an audit log here would be
 * the empty table this page exists to refuse.
 */
export function PendingScreen({
  title,
  from,
}: {
  readonly title: string;
  readonly from: string;
}) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="hint">
        This screen loads from {from} once that route is live. Nothing here is invented while
        the gateway has no payload to render.
      </p>
    </section>
  );
}
