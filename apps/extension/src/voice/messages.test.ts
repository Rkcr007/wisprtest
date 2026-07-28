import { describe, expect, it } from 'vitest';

import {
  parseOffscreenCommand,
  parseOffscreenEvent,
  SPEECH_TO_PARTIAL_METRIC,
} from './messages.js';

describe('offscreen event contract', () => {
  it('parses each event variant', () => {
    expect(parseOffscreenEvent({ kind: 'phase', phase: 'listening' })?.kind).toBe('phase');
    expect(parseOffscreenEvent({ kind: 'level', level: 0.4 })?.kind).toBe('level');
    expect(parseOffscreenEvent({ kind: 'partial', revision: 3, transcript: 'open orders' })).toEqual(
      { kind: 'partial', revision: 3, transcript: 'open orders' },
    );
    expect(parseOffscreenEvent({ kind: 'final', revision: 4, transcript: 'open orders' })?.kind).toBe(
      'final',
    );
    expect(
      parseOffscreenEvent({ kind: 'metric', name: SPEECH_TO_PARTIAL_METRIC, valueMs: 120 })?.kind,
    ).toBe('metric');
    expect(parseOffscreenEvent({ kind: 'error', reason: 'mic_denied' })?.kind).toBe('error');
  });

  it('rejects out-of-range and unknown shapes', () => {
    expect(parseOffscreenEvent({ kind: 'level', level: 1.5 })).toBeNull();
    expect(parseOffscreenEvent({ kind: 'partial', revision: -1, transcript: 'x' })).toBeNull();
    expect(parseOffscreenEvent({ kind: 'metric', name: 'other', valueMs: 1 })).toBeNull();
    expect(parseOffscreenEvent({ kind: 'nope' })).toBeNull();
    expect(parseOffscreenEvent(null)).toBeNull();
  });
});

describe('offscreen command contract', () => {
  it('parses start with a token and stop', () => {
    expect(parseOffscreenCommand({ kind: 'start', token: 'abc' })).toEqual({
      kind: 'start',
      token: 'abc',
    });
    expect(parseOffscreenCommand({ kind: 'stop' })?.kind).toBe('stop');
  });

  it('rejects a start with no token', () => {
    expect(parseOffscreenCommand({ kind: 'start', token: '' })).toBeNull();
    expect(parseOffscreenCommand({ kind: 'start' })).toBeNull();
  });
});
