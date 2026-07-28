import { describe, expect, it, vi } from 'vitest';

import { CDP_MESSAGE } from '../executor/index.js';
import { createCdpDispatchService, type DebuggerApi } from './cdp-dispatch.js';

function fakeDebugger(overrides: Partial<DebuggerApi> = {}): DebuggerApi & {
  attaches: number[];
  commands: { tabId: number; method: string }[];
} {
  const attaches: number[] = [];
  const commands: { tabId: number; method: string }[] = [];
  return {
    attaches,
    commands,
    attach: overrides.attach ?? ((target) => {
      attaches.push(target.tabId);
      return Promise.resolve();
    }),
    detach: overrides.detach ?? (() => Promise.resolve()),
    sendCommand: overrides.sendCommand ?? ((target, method) => {
      commands.push({ tabId: target.tabId, method });
      return Promise.resolve();
    }),
  };
}

const mouseMessage = {
  type: CDP_MESSAGE,
  command: { kind: 'mouse', event: { type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 } },
} as const;

describe('createCdpDispatchService', () => {
  it('attaches the debugger once and replays the command to the tab', async () => {
    const dbg = fakeDebugger();
    const service = createCdpDispatchService(dbg);

    expect(await service.handle(mouseMessage, 7)).toEqual({ ok: true });
    expect(await service.handle(mouseMessage, 7)).toEqual({ ok: true });

    // Attached once for the tab, both commands dispatched to it.
    expect(dbg.attaches).toEqual([7]);
    expect(dbg.commands).toEqual([
      { tabId: 7, method: 'Input.dispatchMouseEvent' },
      { tabId: 7, method: 'Input.dispatchMouseEvent' },
    ]);
  });

  it('reports a reason instead of throwing when a command fails, and re-attaches next time', async () => {
    const sendCommand = vi
      .fn<DebuggerApi['sendCommand']>()
      .mockRejectedValueOnce(new Error('debuggee closed'))
      .mockResolvedValue(undefined);
    const dbg = fakeDebugger({ sendCommand });
    const service = createCdpDispatchService(dbg);

    const first = await service.handle(mouseMessage, 3);
    expect(first).toEqual({ ok: false, error: 'Error: debuggee closed' });

    // The failed session was dropped, so the next dispatch re-attaches rather than assuming health.
    await service.handle(mouseMessage, 3);
    expect(dbg.attaches).toEqual([3, 3]);
  });

  it('refuses a command with no tab', async () => {
    const service = createCdpDispatchService(fakeDebugger());
    expect(await service.handle(mouseMessage, undefined)).toEqual({
      ok: false,
      error: 'no tab to dispatch to',
    });
  });

  it('ignores messages that are not ours', () => {
    const service = createCdpDispatchService(fakeDebugger());
    expect(service.isCdpMessage({ type: 'something-else' })).toBe(false);
    expect(service.isCdpMessage(mouseMessage)).toBe(true);
  });

  it('detaches on release', () => {
    const detach = vi.fn(() => Promise.resolve());
    const service = createCdpDispatchService(fakeDebugger({ detach }));
    return service.handle(mouseMessage, 5).then(() => {
      service.release(5);
      expect(detach).toHaveBeenCalledWith({ tabId: 5 });
    });
  });
});
