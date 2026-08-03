/**
 * Loading placeholders shaped like the thing that is loading.
 *
 * Phase 18: "Loading states are skeletons matching final layout, never spinners on full pages."
 * A spinner tells a tester that something is happening; a skeleton tells them what is about to
 * appear and stops the page jumping when it does. Marked `aria-hidden` with a single polite
 * status beside it, because a screen reader should hear "loading progress", not sixty grey boxes.
 */
export function SkeletonRow({ widths }: { widths: readonly string[] }) {
  return (
    <tr aria-hidden="true">
      {widths.map((width, index) => (
        <td key={index}>
          <span className="skeleton" style={{ display: 'block', width }} />
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
          <span className="skeleton" style={{ display: 'block', width: '72px', height: '24px' }} />
        </span>
      ))}
    </div>
  );
}
