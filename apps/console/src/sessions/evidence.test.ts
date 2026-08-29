import { SessionTimeline } from 'protocol';
import { describe, expect, it } from 'vitest';

import { EVIDENCE_KEY, SESSION_TIMELINE } from '../drift/fixtures';
import { signedEvidenceFor } from './evidence';

describe('signedEvidenceFor', () => {
  it('returns the signed entry for a key the timeline resolved', () => {
    const found = signedEvidenceFor(SESSION_TIMELINE.evidence, EVIDENCE_KEY);

    expect(found?.url).toBe(
      'https://evidence.wisprtest.example/tenants/3f2504e0/step-4.png?sig=abc',
    );
  });

  it('returns null rather than inventing a URL for an unsigned key', () => {
    expect(signedEvidenceFor(SESSION_TIMELINE.evidence, 'tenants/other/missing.png')).toBeNull();
    expect(signedEvidenceFor([], EVIDENCE_KEY)).toBeNull();
  });

  it('the fixture timeline is contract-valid', () => {
    expect(SessionTimeline.safeParse(SESSION_TIMELINE).success).toBe(true);
  });
});
