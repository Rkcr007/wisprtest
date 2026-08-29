import { describe, expect, it } from 'vitest';

import { GatewayError } from '../errors.js';
import { parsePage } from './page.js';

describe('parsePage', () => {
  it('defaults to fifty rows from the start', () => {
    expect(parsePage({})).toEqual({ limit: 50, offset: 0 });
  });

  it('coerces query-string numbers', () => {
    expect(parsePage({ limit: '10', offset: '20' })).toEqual({ limit: 10, offset: 20 });
  });

  it('refuses a page larger than one hundred', () => {
    expect(() => parsePage({ limit: '101' })).toThrow(GatewayError);
  });

  it('refuses a negative offset', () => {
    expect(() => parsePage({ offset: '-1' })).toThrow(GatewayError);
  });
});
