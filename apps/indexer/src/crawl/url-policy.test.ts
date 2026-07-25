import type { CrawlBounds } from 'protocol';
import { describe, expect, it } from 'vitest';

import { SsrfError } from '../errors.js';
import { classify, createUrlPolicy, isPathAllowed } from './url-policy.js';

const bounds = (overrides: Partial<CrawlBounds> = {}): CrawlBounds => ({
  allowedOrigins: ['https://orders.northwind.example'],
  routeAllowlist: ['/orders', '/settings'],
  maxDepth: 3,
  maxPages: 50,
  neverInteractSelectors: [],
  maxInteractionsPerRoute: 4,
  interactionObserveMs: 500,
  settleDelayMs: 10,
  networkIdleTimeoutMs: 1000,
  navigationTimeoutMs: 5000,
  requestsPerMinute: 60,
  viewport: { width: 1280, height: 720 },
  ...overrides,
});

/** A resolver under the test's control: DNS is exactly what an SSRF check must not trust. */
const resolvesTo =
  (map: Record<string, string[]>) =>
  (hostname: string): Promise<string[]> => {
    const addresses = map[hostname];
    if (addresses === undefined) return Promise.reject(new Error('NXDOMAIN'));
    return Promise.resolve(addresses);
  };

const publicDns = resolvesTo({ 'orders.northwind.example': ['93.184.216.34'] });

describe('scheme and shape', () => {
  it('rejects a non-http scheme', async () => {
    const policy = createUrlPolicy(bounds(), publicDns);
    await expect(policy.assertAllowed('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
    await expect(policy.assertAllowed('javascript:alert(1)')).rejects.toBeInstanceOf(SsrfError);
    await expect(policy.assertAllowed('data:text/html,<h1>x</h1>')).rejects.toBeInstanceOf(
      SsrfError,
    );
  });

  it('rejects a URL carrying embedded credentials', async () => {
    const policy = createUrlPolicy(bounds(), publicDns);
    await expect(
      policy.assertAllowed('https://user:secret@orders.northwind.example/orders'),
    ).rejects.toThrow(/embedded credentials/);
  });

  it('never puts the credentials in the error it throws', async () => {
    const policy = createUrlPolicy(bounds(), publicDns);
    const error = await policy
      .assertAllowed('https://user:hunter2@orders.northwind.example/orders')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SsrfError);
    expect(JSON.stringify(error)).not.toContain('hunter2');
    expect((error as SsrfError).message).not.toContain('hunter2');
  });
});

describe('the allowlist', () => {
  it('accepts a URL on an allowed origin and an allowed path', async () => {
    const policy = createUrlPolicy(bounds(), publicDns);
    const url = await policy.assertAllowed('https://orders.northwind.example/orders/1841');
    expect(url.pathname).toBe('/orders/1841');
  });

  it('rejects another origin, however plausible', async () => {
    const policy = createUrlPolicy(bounds(), publicDns);
    await expect(
      policy.assertAllowed('https://orders.northwind.example.attacker.test/orders'),
    ).rejects.toThrow(/not on the application allowlist/);
  });

  it('rejects a path outside the route allowlist', async () => {
    const policy = createUrlPolicy(bounds(), publicDns);
    await expect(policy.assertAllowed('https://orders.northwind.example/admin')).rejects.toThrow(
      /outside the route allowlist/,
    );
  });

  it('matches prefixes by segment, not by string', () => {
    // `/order` must not admit `/orders-admin`; half a path segment is not a prefix anybody wrote.
    expect(isPathAllowed('/orders/1841', ['/orders'])).toBe(true);
    expect(isPathAllowed('/orders', ['/orders'])).toBe(true);
    expect(isPathAllowed('/orders-admin', ['/orders'])).toBe(false);
    expect(isPathAllowed('/anything/at/all', ['/'])).toBe(true);
  });

  it('resolves a relative link against the page it was found on', async () => {
    const policy = createUrlPolicy(bounds(), publicDns);
    const url = await policy.assertAllowed(
      '../settings',
      'https://orders.northwind.example/orders/1841',
    );
    expect(url.href).toBe('https://orders.northwind.example/settings');
  });
});

describe('address classification', () => {
  it('blocks the cloud metadata address whatever it is dressed as', () => {
    expect(classify('169.254.169.254')).toBe('blocked');
    expect(classify('::ffff:169.254.169.254')).toBe('blocked');
    expect(classify('fe80::1')).toBe('blocked');
    expect(classify('0.0.0.0')).toBe('blocked');
    expect(classify('224.0.0.1')).toBe('blocked');
  });

  it('classifies loopback and private ranges as private', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.9',
      '192.168.1.4',
      '::1',
      'fd00::1',
    ]) {
      expect(classify(address), address).toBe('private');
    }
  });

  it('classifies routable addresses as public', () => {
    expect(classify('93.184.216.34')).toBe('public');
    expect(classify('2606:2800:220:1:248:1893:25c8:1946')).toBe('public');
  });
});

describe('rebinding and internal targets', () => {
  it('rejects an allowlisted name that resolves somewhere private', async () => {
    // The rebinding case: the origin is exactly what the tenant configured, and the name now
    // points at their internal network.
    const policy = createUrlPolicy(
      bounds(),
      resolvesTo({ 'orders.northwind.example': ['10.0.0.5'] }),
    );
    await expect(policy.assertAllowed('https://orders.northwind.example/orders')).rejects.toThrow(
      /resolves to a private address/,
    );
  });

  it('rejects an allowlisted name that resolves to the metadata service', async () => {
    const policy = createUrlPolicy(
      bounds(),
      resolvesTo({ 'orders.northwind.example': ['169.254.169.254'] }),
    );
    await expect(policy.assertAllowed('https://orders.northwind.example/orders')).rejects.toThrow(
      /resolves to a blocked address/,
    );
  });

  it('permits a private address the tenant named literally', async () => {
    // A staging application on an internal host is the common case, and a literal address cannot
    // be repointed by whoever controls DNS.
    const policy = createUrlPolicy(
      bounds({ allowedOrigins: ['http://10.20.30.40:8080'], routeAllowlist: ['/'] }),
      resolvesTo({ '10.20.30.40': ['10.20.30.40'] }),
    );
    const url = await policy.assertAllowed('http://10.20.30.40:8080/orders');
    expect(url.port).toBe('8080');
  });

  it('permits localhost when it is what was configured', async () => {
    const policy = createUrlPolicy(
      bounds({ allowedOrigins: ['http://127.0.0.1:4300'], routeAllowlist: ['/'] }),
      resolvesTo({ '127.0.0.1': ['127.0.0.1'] }),
    );
    await expect(policy.assertAllowed('http://127.0.0.1:4300/orders')).resolves.toBeInstanceOf(URL);
  });

  it('rejects a hostname that does not resolve at all', async () => {
    const policy = createUrlPolicy(bounds(), resolvesTo({}));
    await expect(policy.assertAllowed('https://orders.northwind.example/orders')).rejects.toThrow(
      /does not resolve/,
    );
  });

  it('resolves each hostname once, however many links point at it', async () => {
    let lookups = 0;
    const policy = createUrlPolicy(bounds(), (hostname) => {
      lookups += 1;
      return Promise.resolve(hostname === 'orders.northwind.example' ? ['93.184.216.34'] : []);
    });

    await policy.assertAllowed('https://orders.northwind.example/orders/1');
    await policy.assertAllowed('https://orders.northwind.example/orders/2');
    await policy.assertAllowed('https://orders.northwind.example/settings');

    expect(lookups).toBe(1);
  });
});

describe('isAllowed', () => {
  it('answers without throwing, for filtering discovered links', async () => {
    const policy = createUrlPolicy(bounds(), publicDns);
    expect(await policy.isAllowed('https://orders.northwind.example/orders')).toBe(true);
    expect(await policy.isAllowed('mailto:ops@northwind.example')).toBe(false);
    expect(await policy.isAllowed('https://elsewhere.example/orders')).toBe(false);
  });
});
