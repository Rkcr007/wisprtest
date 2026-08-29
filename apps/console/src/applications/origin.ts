/**
 * Origin of an absolute http(s) URL, or null.
 *
 * The gateway keys applications by origin (not the full URL): that is what the extension sends
 * on attach, and two apps in one tenant cannot share one. The console uses the same reduction
 * when it reuses a row and when it fills the crawl allowlist from the base URL the tester named.
 */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
