import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeGatewayReady, stripUserinfo } from './readyz';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stripUserinfo', () => {
  it('removes credentials so they cannot travel on the probe', () => {
    expect(stripUserinfo('http://probe:s3cret@gateway.internal:8080/')).toBe(
      'http://gateway.internal:8080/',
    );
  });

  it('leaves an ordinary URL alone', () => {
    expect(stripUserinfo('http://gateway.internal:8080')).toBe('http://gateway.internal:8080/');
  });
});

describe('probeGatewayReady', () => {
  it('treats a 200 from /readyz as ready and never sends an Authorization header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"status":"ready"}', { status: 200 }));

    await expect(
      probeGatewayReady('http://gateway.internal:8080', { fetch: fetchMock }),
    ).resolves.toEqual({ status: 'ready', httpStatus: 200 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://gateway.internal:8080/readyz');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
  });

  it('does not fall through to /healthz when /readyz answers 503', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"status":"not_ready"}', { status: 503 }));

    await expect(
      probeGatewayReady('http://gateway.internal:8080', { fetch: fetchMock }),
    ).resolves.toEqual({ status: 'not_ready', httpStatus: 503 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gateway.internal:8080/readyz');
  });

  it('falls back to /healthz when /readyz is missing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));

    await expect(
      probeGatewayReady('http://gateway.internal:8080', { fetch: fetchMock }),
    ).resolves.toEqual({ status: 'ready', httpStatus: 200 });

    expect(fetchMock.mock.calls.map((call) => call[0] as string)).toEqual([
      'http://gateway.internal:8080/readyz',
      'http://gateway.internal:8080/healthz',
    ]);
  });

  it('strips userinfo before fetching', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"status":"ready"}', { status: 200 }));

    await probeGatewayReady('http://probe:s3cret@gateway.internal:8080', { fetch: fetchMock });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gateway.internal:8080/readyz');
  });

  it('reports unreachable when neither endpoint answers', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      probeGatewayReady('http://gateway.internal:8080', { fetch: fetchMock }),
    ).resolves.toEqual({ status: 'unreachable', httpStatus: null });
  });
});
