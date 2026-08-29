import { describe, expect, it } from 'vitest';

import { originOf } from './origin';

describe('originOf', () => {
  it('keeps the origin and drops the path', () => {
    expect(originOf('https://app.example.com/orders?q=1')).toBe('https://app.example.com');
  });

  it('refuses a value that is not an http(s) URL', () => {
    expect(originOf('app.example.com')).toBeNull();
    expect(originOf('ftp://app.example.com')).toBeNull();
    expect(originOf('')).toBeNull();
  });
});
