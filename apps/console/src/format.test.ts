import { describe, expect, it } from 'vitest';

import { formatIndexAge } from './format';

describe('formatIndexAge', () => {
  const now = Date.parse('2026-08-29T12:00:00.000Z');

  it('says never indexed when there is no version', () => {
    expect(formatIndexAge(null, now)).toBe('never indexed');
  });

  it('uses hours under two days and days after that', () => {
    expect(formatIndexAge('2026-08-29T11:30:00.000Z', now)).toBe('under an hour');
    expect(formatIndexAge('2026-08-28T12:00:00.000Z', now)).toBe('24h ago');
    expect(formatIndexAge('2026-08-26T12:00:00.000Z', now)).toBe('3d ago');
  });
});
