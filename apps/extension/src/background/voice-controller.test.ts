import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HudVoice } from '../messaging.js';
import type { OffscreenCommand } from '../voice/messages.js';
import { createVoiceController, type VoiceController } from './voice-controller.js';

/**
 * The worker's half of the pipeline, tested without `chrome`: a fake {@link OffscreenManager} and a
 * plain port. It distils the offscreen event stream into one HudVoice and guards the credential.
 */

function fakeOffscreen() {
  return {
    ensure: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    send: vi.fn<(command: OffscreenCommand) => Promise<void>>(() => Promise.resolve()),
  };
}

function collectingPort(): { postMessage: (m: unknown) => void; posts: HudVoice[] } {
  const posts: HudVoice[] = [];
  return { postMessage: (m: unknown) => posts.push(m as HudVoice), posts };
}

let offscreen: ReturnType<typeof fakeOffscreen>;

beforeEach(() => {
  offscreen = fakeOffscreen();
});

describe('start — credential handling', () => {
  it('shows connecting, mints a token, and starts capture', async () => {
    const controller = createVoiceController({
      offscreen,
      mintToken: () => Promise.resolve('tok'),
    });
    const port = collectingPort();

    await controller.start(port);

    expect(port.posts[0]).toMatchObject({ kind: 'voice', phase: 'connecting' });
    expect(offscreen.ensure).toHaveBeenCalledTimes(1);
    expect(offscreen.send).toHaveBeenCalledWith({ kind: 'start', token: 'tok' });
  });

  it('surfaces an honest error and opens no microphone when no token is available', async () => {
    const controller = createVoiceController({ offscreen, mintToken: () => Promise.resolve(null) });
    const port = collectingPort();

    await controller.start(port);

    expect(port.posts.at(-1)).toMatchObject({ phase: 'error' });
    expect(offscreen.ensure).not.toHaveBeenCalled();
    expect(offscreen.send).not.toHaveBeenCalled();
  });

  it('reports an error if minting throws, never leaking the reason to the pipeline', async () => {
    const onError = vi.fn<(event: string, error: unknown) => void>();
    const controller = createVoiceController({
      offscreen,
      mintToken: () => Promise.reject(new Error('gateway 503')),
      onError,
    });
    const port = collectingPort();

    await controller.start(port);

    expect(port.posts.at(-1)).toMatchObject({ phase: 'error' });
    expect(onError).toHaveBeenCalled();
    expect(offscreen.send).not.toHaveBeenCalled();
  });
});

describe('event distillation', () => {
  let controller: VoiceController;
  let port: ReturnType<typeof collectingPort>;

  beforeEach(async () => {
    controller = createVoiceController({ offscreen, mintToken: () => Promise.resolve('tok') });
    port = collectingPort();
    await controller.start(port);
    port.posts.length = 0; // drop the start-time posts; assert on events from here
  });

  it('folds a partial into the unconfirmed tail and a final into the confirmed line', () => {
    controller.handleEvent({ kind: 'partial', revision: 3, transcript: 'show me the bending' });
    expect(port.posts.at(-1)?.partial).toEqual({ revision: 3, text: 'show me the bending' });

    controller.handleEvent({
      kind: 'final',
      revision: 4,
      transcript: 'show me the pending orders',
    });
    const last = port.posts.at(-1);
    expect(last?.final).toEqual({ revision: 4, text: 'show me the pending orders' });
    expect(last?.partial).toBeNull(); // the tail clears when the line is confirmed
  });

  it('tracks the live level and phase', () => {
    controller.handleEvent({ kind: 'level', level: 0.7 });
    expect(port.posts.at(-1)?.level).toBe(0.7);

    controller.handleEvent({ kind: 'phase', phase: 'listening' });
    expect(port.posts.at(-1)?.phase).toBe('listening');
  });

  it('forwards the metric out of band without posting to the HUD', () => {
    const onMetric = vi.fn<(name: string, valueMs: number) => void>();
    const metered = createVoiceController({
      offscreen,
      mintToken: () => Promise.resolve('tok'),
      onMetric,
    });
    const p = collectingPort();
    metered.handleEvent({ kind: 'metric', name: 'wispr_speech_to_partial_ms', valueMs: 42 });
    expect(onMetric).toHaveBeenCalledWith('wispr_speech_to_partial_ms', 42);
    expect(p.posts).toHaveLength(0);
  });

  it('clears the meter and releases the offscreen document on idle', () => {
    controller.handleEvent({ kind: 'level', level: 0.7 });
    controller.handleEvent({ kind: 'phase', phase: 'idle' });
    const last = port.posts.at(-1);
    expect(last).toMatchObject({ phase: 'idle', level: 0, partial: null });
    expect(offscreen.close).toHaveBeenCalled();
  });

  it('ignores a message that is not a valid offscreen event', () => {
    controller.handleEvent({ kind: 'garbage' });
    controller.handleEvent(null);
    controller.handleEvent({ kind: 'level', level: 5 }); // out of range
    expect(port.posts).toHaveLength(0);
  });
});

describe('session ownership', () => {
  it('last start wins, and a stop from a displaced tab is ignored', async () => {
    const controller = createVoiceController({
      offscreen,
      mintToken: () => Promise.resolve('tok'),
    });
    const first = collectingPort();
    const second = collectingPort();

    await controller.start(first);
    await controller.start(second); // second tab takes the floor
    offscreen.send.mockClear();

    await controller.stop(first); // the displaced tab's release must not stop the active session
    expect(offscreen.send).not.toHaveBeenCalled();

    await controller.stop(second);
    expect(offscreen.send).toHaveBeenCalledWith({ kind: 'stop' });
  });

  it('stops posting to a released port and closes the document', () => {
    const controller = createVoiceController({
      offscreen,
      mintToken: () => Promise.resolve('tok'),
    });
    const port = collectingPort();
    void controller.start(port);

    controller.release(port);
    port.posts.length = 0;
    controller.handleEvent({ kind: 'phase', phase: 'listening' });
    expect(port.posts).toHaveLength(0); // nothing lands on a released port
    expect(offscreen.close).toHaveBeenCalled();
  });
});
