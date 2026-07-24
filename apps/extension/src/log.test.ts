import { describe, expect, it } from 'vitest';

import { createLogger, formatLine } from './log.js';

const context = { service: 'extension', env: 'test' } as const;

describe('formatLine', () => {
  it('produces one parseable JSON object with the shared line shape', () => {
    const line = formatLine(
      context,
      'info',
      'service.started',
      { trigger: 'install:install' },
      'extension service worker started',
      new Date('2026-07-25T09:30:00.000Z'),
    );

    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed).toEqual({
      level: 'info',
      time: '2026-07-25T09:30:00.000Z',
      service: 'extension',
      env: 'test',
      event: 'service.started',
      trigger: 'install:install',
      msg: 'extension service worker started',
    });
  });

  it('timestamps in ISO 8601 UTC', () => {
    const line = formatLine(context, 'info', 'service.started', {}, 'started');
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('never lets a caller field overwrite a reserved key', () => {
    const line = formatLine(
      context,
      'warn',
      'drift.detected',
      { msg: 'injected', level: 'info', service: 'not-the-extension' },
      'real message',
    );
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.msg).toBe('real message');
    expect(parsed.level).toBe('warn');
    expect(parsed.service).toBe('extension');
  });
});

describe('createLogger', () => {
  it('writes exactly one line per call to the sink', () => {
    const lines: string[] = [];
    const logger = createLogger(context, (line) => lines.push(line));

    logger.log('info', 'service.started', { trigger: 'browser_startup' }, 'started');
    logger.log('error', 'attach.failed', { attempt: 2 }, 'could not attach');

    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1] ?? '') as Record<string, unknown>).attempt).toBe(2);
  });
});
