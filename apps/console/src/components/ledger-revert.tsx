'use client';

import { useState } from 'react';

/**
 * Revert one ledger entry through the console BFF.
 *
 * Class S: never speculative, confirmation is this click after the preview row is already
 * visible. The gateway still enforces `seed:revert`.
 */
export function LedgerRevert({ ledgerEntryId }: { readonly ledgerEntryId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) return <span className="status-approved">reverted</span>;

  return (
    <span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void (async () => {
            setBusy(true);
            setError(null);
            const response = await fetch('/api/seed/revert', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ scope: 'entry', ledgerEntryId }),
            });
            const payload: unknown = await response.json().catch(() => null);
            setBusy(false);
            if (!response.ok) {
              const message =
                payload !== null &&
                typeof payload === 'object' &&
                'message' in payload &&
                typeof payload.message === 'string'
                  ? payload.message
                  : 'the console could not revert that record';
              setError(message);
              return;
            }
            setDone(true);
          })();
        }}
      >
        {busy ? 'Reverting…' : 'Revert'}
      </button>
      {error === null ? null : (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
