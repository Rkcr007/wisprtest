import { describe, expect, it, vi } from 'vitest';

import {
  createDebuggerDispatcher,
  createRelayDispatcher,
  keyParams,
  mouseParams,
  runCdpCommand,
  type CdpCommand,
} from './cdp.js';

describe('command translation', () => {
  it('builds Input.dispatchMouseEvent params with the pressed-button bitfield', () => {
    expect(
      mouseParams({ type: 'mousePressed', x: 12, y: 34, button: 'left', clickCount: 1 }),
    ).toEqual({
      type: 'mousePressed',
      x: 12,
      y: 34,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    });
    // Release clears the bitfield.
    expect(
      mouseParams({ type: 'mouseReleased', x: 12, y: 34, button: 'left', clickCount: 1 }).buttons,
    ).toBe(0);
  });

  it('drops undefined key fields so the protocol payload stays minimal', () => {
    expect(keyParams({ type: 'keyDown', key: 'a', text: 'a' })).toEqual({
      type: 'keyDown',
      key: 'a',
      text: 'a',
    });
    expect('windowsVirtualKeyCode' in keyParams({ type: 'keyUp', key: 'a' })).toBe(false);
  });
});

describe('createDebuggerDispatcher', () => {
  it('routes mouse and key events to the two protocol methods', async () => {
    const sendCommand = vi.fn((_method: string, _params: Record<string, unknown>) =>
      Promise.resolve(),
    );
    const dispatcher = createDebuggerDispatcher(sendCommand);

    await dispatcher.mouse({ type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 });
    await dispatcher.key({ type: 'keyDown', key: 'a', text: 'a' });

    expect(sendCommand.mock.calls[0]?.[0]).toBe('Input.dispatchMouseEvent');
    expect(sendCommand.mock.calls[1]?.[0]).toBe('Input.dispatchKeyEvent');
  });
});

describe('the relay, content script → worker', () => {
  it('forwards each command and the worker runs it against the transport', async () => {
    const relayed: CdpCommand[] = [];
    // The content-side dispatcher: it only forwards.
    const dispatcher = createRelayDispatcher((command) => {
      relayed.push(command);
      return Promise.resolve();
    });
    await dispatcher.mouse({ type: 'mousePressed', x: 5, y: 6, button: 'left', clickCount: 1 });

    expect(relayed).toEqual([
      { kind: 'mouse', event: { type: 'mousePressed', x: 5, y: 6, button: 'left', clickCount: 1 } },
    ]);

    // The worker side: it replays the relayed command onto its sendCommand transport.
    const sendCommand = vi.fn((_method: string, _params: Record<string, unknown>) =>
      Promise.resolve(),
    );
    const [command] = relayed;
    if (command === undefined) throw new Error('no command was relayed');
    await runCdpCommand(sendCommand, command);
    expect(sendCommand).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ x: 5 }),
    );
  });

  it('propagates a worker failure so the executor can record a failed action', async () => {
    const dispatcher = createRelayDispatcher(() => Promise.reject(new Error('no debuggee')));
    await expect(dispatcher.key({ type: 'keyDown', key: 'a', text: 'a' })).rejects.toThrow(
      'no debuggee',
    );
  });
});
