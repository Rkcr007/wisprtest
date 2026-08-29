/**
 * Display helpers for timestamps and rates the console renders.
 *
 * UTC and ISO-shaped, matching the Connect "started at" column: one representation, no locale
 * surprises between a tester in one timezone and a lead in another.
 */

export function formatUtc(iso: string): string {
  return `${new Date(iso).toISOString().replace('T', ' ').slice(0, 19)}Z`;
}

export function formatRate(rate: number): string {
  return `${String(Math.round(rate * 100))}%`;
}

export function formatLatencyMs(latencyMs: number): string {
  return `${String(Math.round(latencyMs))} ms`;
}

/**
 * How long ago an active memory version was created.
 *
 * Hours, not a coverage score. An application that has never been indexed says so — that is
 * the honest Connect column, not a fabricated freshness percentage.
 */
export function formatIndexAge(indexedAt: string | null, now: number = Date.now()): string {
  if (indexedAt === null) return 'never indexed';
  const elapsedMs = now - Date.parse(indexedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'never indexed';
  const hours = elapsedMs / 3_600_000;
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${String(Math.round(hours))}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}
