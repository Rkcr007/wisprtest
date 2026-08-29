import { CrawlBounds } from 'protocol';
import { describe, expect, it } from 'vitest';

import { BoundsError } from '../errors.js';
import { dumpBounds } from './bounds.js';

describe('dumpBounds', () => {
  it('returns contract-valid bounds whose allowlist is the origin', () => {
    const bounds = dumpBounds({ origin: 'http://127.0.0.1:4310' });
    expect(CrawlBounds.parse(bounds)).toEqual(bounds);
    expect(bounds.allowedOrigins).toEqual(['http://127.0.0.1:4310']);
    expect(bounds.routeAllowlist).toEqual(['/']);
    expect(bounds.maxDepth).toBe(2);
    expect(bounds.maxPages).toBe(25);
    expect(bounds.requestsPerMinute).toBe(60);
  });

  it('honours depth, page, rate and never-interact overrides', () => {
    const bounds = dumpBounds({
      origin: 'https://staging.example.com',
      maxDepth: 1,
      maxPages: 4,
      requestsPerMinute: 30,
      neverInteractSelectors: ['[data-destructive]'],
    });
    expect(bounds.maxDepth).toBe(1);
    expect(bounds.maxPages).toBe(4);
    expect(bounds.requestsPerMinute).toBe(30);
    expect(bounds.neverInteractSelectors).toEqual(['[data-destructive]']);
  });

  it('refuses a bad origin before a browser would launch', () => {
    expect(() => dumpBounds({ origin: 'not-a-url' })).toThrow(BoundsError);
    expect(() => dumpBounds({ origin: 'ftp://example.com' })).toThrow(BoundsError);
  });
});
