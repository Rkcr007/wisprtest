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
