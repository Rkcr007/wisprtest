import { isIP } from 'node:net';

import type { CrawlBounds } from 'protocol';

import { SsrfError } from '../errors.js';

/**
 * The SSRF guard. ARCHITECTURE § 8: "indexer targets are allowlisted per application; no
 * user-supplied URL reaches the crawler unvalidated."
 *
 * Every navigation goes through {@link UrlPolicy.assertAllowed} — the entry URL, every link the
 * crawler discovers, every redirect hop, and the target of every click that navigates. There is
 * no code path in the crawler that calls `page.goto` with a URL this has not returned.
 *
 * ## Four checks, in order
 *
 * 1. **Scheme** — `http` and `https` only. `file:`, `data:`, `javascript:` and everything else
 *    are rejected. This is the check the contract's `HttpUrl` also makes, repeated here because
 *    links discovered in a page never passed through the contract.
 * 2. **No embedded credentials** — `https://user:pass@host/` is rejected outright. Such a URL is
 *    either an attempt to make the crawler authenticate somewhere it should not, or a credential
 *    about to be written into a log line.
 * 3. **Origin allowlist** — the origin must appear in the application's configured
 *    `allowedOrigins`, and the path must sit under one of its `routeAllowlist` prefixes.
 * 4. **Address class** — the hostname is resolved and the resulting addresses are classified.
 *
 * ## What the address check does, and why it is not simply "reject anything private"
 *
 * Two categories are rejected unconditionally, because no application under test lives there and
 * they are precisely what an SSRF is aimed at: link-local (`169.254.0.0/16`, `fe80::/10` — cloud
 * instance metadata) and the unspecified, multicast and reserved ranges.
 *
 * Loopback and private ranges are rejected too, with one deliberate exception: an allowlisted
 * origin whose hostname is *itself* a literal IP address or `localhost`. The threat this guards
 * against is a name that resolves somewhere other than where the tenant thought — DNS rebinding,
 * an internal name that later points at the metadata service, a stale record. A literal address
 * cannot be repointed; what the tenant allowlisted is exactly what is dialled. That exception is
 * also what makes it possible to index a staging application on a private network at all, which
 * is a large share of the real ones.
 *
 * Resolution happens once per host and is cached for the life of a crawl, so this cannot become
 * a per-navigation DNS round trip on a page with a hundred links.
 */

/** How a hostname is resolved to addresses. Injected so the policy is testable without DNS. */
export type AddressLookup = (hostname: string) => Promise<readonly string[]>;

export interface UrlPolicy {
  /**
   * Resolve `rawUrl` against `base` and return it if every check passes.
   *
   * @throws {SsrfError} with a fixed, PII-free reason when it does not.
   */
  assertAllowed(rawUrl: string, base?: string): Promise<URL>;

  /** Whether a URL passes, without throwing. Used to filter discovered links quietly. */
  isAllowed(rawUrl: string, base?: string): Promise<boolean>;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * What the policy actually reads: the two allowlists, and nothing about crawl shape.
 *
 * Narrowed for the same reason as `SessionBounds` — the UI materializer navigates to the
 * application under test and is subject to the same SSRF rules, without being a crawl.
 */
export type PolicyBounds = Pick<CrawlBounds, 'allowedOrigins' | 'routeAllowlist'>;

export function createUrlPolicy(bounds: PolicyBounds, lookup: AddressLookup): UrlPolicy {
  const origins = new Set(bounds.allowedOrigins.map(normalizeOrigin));
  // Hostnames the tenant named literally, and which therefore may resolve to a private address.
  const literalHosts = new Set(
    bounds.allowedOrigins.flatMap((origin) => {
      const hostname = hostnameOf(origin);
      return hostname !== undefined && isLiteralHost(hostname) ? [hostname] : [];
    }),
  );
  const resolved = new Map<string, Promise<readonly string[]>>();

  async function addressesFor(hostname: string): Promise<readonly string[]> {
    const cached = resolved.get(hostname);
    if (cached !== undefined) return cached;

    const pending = lookup(hostname).catch((error: unknown) => {
      // A hostname that will not resolve is not a target; surface it as a rejection rather than
      // letting a DNS error surface as an unexplained crawl failure.
      throw new SsrfError(hostname, `hostname does not resolve (${describe(error)})`);
    });
    resolved.set(hostname, pending);
    return pending;
  }

  async function check(rawUrl: string, base?: string): Promise<URL> {
    let url: URL;
    try {
      url = base === undefined ? new URL(rawUrl) : new URL(rawUrl, base);
    } catch {
      throw new SsrfError(rawUrl, 'not a valid URL');
    }

    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      throw new SsrfError(url.href, `scheme ${url.protocol} is not http or https`);
    }
    if (url.username !== '' || url.password !== '') {
      throw new SsrfError(`${url.origin}${url.pathname}`, 'URL carries embedded credentials');
    }
    if (!origins.has(normalizeOrigin(url.origin))) {
      throw new SsrfError(url.href, 'origin is not on the application allowlist');
    }
    if (!isPathAllowed(url.pathname, bounds.routeAllowlist)) {
      throw new SsrfError(url.href, 'path is outside the route allowlist');
    }

    const hostname = stripBrackets(url.hostname);
    const allowPrivate = literalHosts.has(hostname.toLowerCase());

    for (const address of await addressesFor(hostname)) {
      const verdict = classify(address);
      if (verdict === 'public') continue;
      if (verdict === 'private' && allowPrivate) continue;
      throw new SsrfError(url.href, `resolves to a ${verdict} address`);
    }

    return url;
  }

  return {
    assertAllowed: check,
    isAllowed: async (rawUrl, base) => {
      try {
        await check(rawUrl, base);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Whether `path` sits under one of the allowlisted prefixes.
 *
 * Prefix matching is segment-aware: `/order` does not permit `/orders-admin`, because a prefix
 * that matches half a path segment is not a prefix anybody intended to write.
 */
export function isPathAllowed(path: string, allowlist: readonly string[]): boolean {
  const normalized = path === '' ? '/' : path;
  return allowlist.some((prefix) => {
    if (prefix === '/') return true;
    const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    return normalized === trimmed || normalized.startsWith(`${trimmed}/`);
  });
}

/** Origins compare without a trailing slash and case-insensitively on scheme and host. */
function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.origin.toLowerCase();
  } catch {
    return origin.replace(/\/+$/, '').toLowerCase();
  }
}

function hostnameOf(origin: string): string | undefined {
  try {
    return stripBrackets(new URL(origin).hostname).toLowerCase();
  } catch {
    return undefined;
  }
}

/** `[::1]` in a URL keeps its brackets in `hostname`; address classification must not see them. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** A hostname the tenant pinned to one machine: a literal address, or the loopback name. */
function isLiteralHost(hostname: string): boolean {
  return isIP(hostname) !== 0 || hostname === 'localhost';
}

/** The three verdicts an address can earn. `blocked` is never permitted, by anyone. */
export type AddressClass = 'public' | 'private' | 'blocked';

/**
 * Classify a resolved address.
 *
 * `private` covers addresses that a deliberately configured internal target may legitimately
 * use; `blocked` covers the ranges no application under test is ever reachable at and that exist
 * on this list because they are the SSRF payload — instance metadata above all.
 */
export function classify(address: string): AddressClass {
  const version = isIP(address);
  if (version === 4) return classifyIpv4(address);
  if (version === 6) return classifyIpv6(address.toLowerCase());
  return 'blocked';
}

function classifyIpv4(address: string): AddressClass {
  // `isIP` has already established four decimal octets, so the fallbacks are unreachable; they
  // are here because `noUncheckedIndexedAccess` is on and an assertion would hide a real change.
  const octets = address.split('.').map(Number);
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;

  // 0.0.0.0/8 — "this network". 255.255.255.255 and 224/4 multicast. 240/4 reserved.
  if (a === 0 || a >= 224) return 'blocked';
  // 169.254.0.0/16 — link-local, and the address of the cloud instance metadata service.
  if (a === 169 && b === 254) return 'blocked';

  if (a === 127) return 'private'; // loopback
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64/10 carrier-grade NAT
  if (a === 192 && b === 0) return 'private'; // 192.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return 'private'; // 198.18/15 benchmarking

  return 'public';
}

function classifyIpv6(address: string): AddressClass {
  // An IPv4-mapped or IPv4-compatible address is an IPv4 address wearing a hat. Classify the
  // address it actually reaches, or `::ffff:169.254.169.254` would sail through as "public".
  const mapped = /^::(?:ffff:(?:0{1,4}:)?)?(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped?.[1] !== undefined) return classifyIpv4(mapped[1]);

  if (address === '::' || address === '::0') return 'blocked'; // unspecified
  if (address.startsWith('ff')) return 'blocked'; // ff00::/8 multicast
  if (/^fe[89ab]/.test(address)) return 'blocked'; // fe80::/10 link-local

  if (address === '::1') return 'private'; // loopback
  if (/^f[cd]/.test(address)) return 'private'; // fc00::/7 unique local

  return 'public';
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'lookup failed';
}
