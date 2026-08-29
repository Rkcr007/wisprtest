/**
 * Loading placeholders shaped like the thing that is loading.
 *
 * Phase 18: "Loading states are skeletons matching final layout, never spinners on full pages."
 * A spinner tells a tester that something is happening; a skeleton tells them what is about to
 * appear and stops the page jumping when it does. Marked `aria-hidden` with a single polite
 * status beside it, because a screen reader should hear "loading progress", not sixty grey boxes.
 */
type SkeletonWidth =
  | '20%'
  | '25%'
  | '30%'
  | '35%'
  | '40%'
  | '45%'
  | '50%'
  | '55%'
  | '60%'
  | '65%'
  | '70%'
  | '75%'
  | '80%';

function widthClass(width: SkeletonWidth): string {
  return `skeleton-width-${width.slice(0, -1)}`;
}

export function SkeletonRow({ widths }: { widths: readonly SkeletonWidth[] }) {
  return (
    <tr aria-hidden="true">
      {widths.map((width, index) => (
        <td key={index}>
          <span className={`skeleton skeleton-block ${widthClass(width)}`} />
        </td>
      ))}
    </tr>
  );
}

export function SkeletonChips({ count }: { count: number }) {
  return (
    <div className="chips" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="chip">
          <span className="skeleton skeleton-chip" />
        </span>
      ))}
    </div>
  );
}

/**
 * The Drift queue, empty of reports: same columns, same caption slot, same chip row.
 *
 * Suspense fallback for the server fetch. A spinner here would say "something" and then jump
 * when the table arrived; this is already the table.
 */
export function DriftQueueSkeleton() {
  return (
    <section className="card" aria-busy="true">
      <h2>Drift</h2>
      <p className="visually-hidden" role="status">
        Loading drift reports
      </p>
      <SkeletonChips count={2} />
      <div className="scroll">
        <table>
          <caption>Pending reports, newest first.</caption>
          <thead>
            <tr>
              <th scope="col">Route</th>
              <th scope="col">Status</th>
              <th scope="col">Alias survival</th>
              <th scope="col">Detected</th>
              <th scope="col">Raised</th>
              <th scope="col">Review</th>
            </tr>
          </thead>
          <tbody>
            <SkeletonRow widths={['70%', '40%', '35%', '40%', '55%', '45%']} />
            <SkeletonRow widths={['55%', '40%', '35%', '40%', '55%', '45%']} />
            <SkeletonRow widths={['65%', '40%', '35%', '40%', '55%', '45%']} />
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * The Session timeline, empty of steps: chips then the same seven columns the live table uses.
 */
export function SessionTimelineSkeleton() {
  return (
    <section className="card" aria-busy="true">
      <h2>Session</h2>
      <p className="visually-hidden" role="status">
        Loading session timeline
      </p>
      <SkeletonChips count={4} />
      <div className="scroll">
        <table>
          <caption>Recorded steps, in ordinal order.</caption>
          <thead>
            <tr>
              <th scope="col" className="numeric">
                #
              </th>
              <th scope="col">Utterance</th>
              <th scope="col">Tier</th>
              <th scope="col">Class</th>
              <th scope="col">Outcome</th>
              <th scope="col" className="numeric">
                Latency
              </th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            <SkeletonRow widths={['20%', '80%', '30%', '25%', '40%', '35%', '50%']} />
            <SkeletonRow widths={['20%', '65%', '30%', '25%', '40%', '35%', '50%']} />
            <SkeletonRow widths={['20%', '75%', '30%', '25%', '40%', '35%', '50%']} />
          </tbody>
        </table>
      </div>
    </section>
  );
}
