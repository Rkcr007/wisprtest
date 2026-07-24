import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';

function captureLines(): { lines: string[]; destination: { write: (chunk: string) => void } } {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    },
  };
}

describe('createLogger', () => {
  it('emits parseable JSON carrying the service, environment and level label', () => {
    const { lines, destination } = captureLines();
    const logger = createLogger({ service: 'gateway', level: 'info', env: 'test' }, destination);

    logger.info({ event: 'service.started', port: 8080 }, 'gateway started');

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '') as Record<string, unknown>;

    expect(line.service).toBe('gateway');
    expect(line.env).toBe('test');
    expect(line.level).toBe('info');
    expect(line.event).toBe('service.started');
    expect(line.msg).toBe('gateway started');
  });

  it('timestamps in ISO 8601 UTC', () => {
    const { lines, destination } = captureLines();
    const logger = createLogger({ service: 'gateway', level: 'info', env: 'test' }, destination);

    logger.info({ event: 'service.started' }, 'gateway started');

    const line = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('honours the configured level', () => {
    const { lines, destination } = captureLines();
    const logger = createLogger({ service: 'gateway', level: 'warn', env: 'test' }, destination);

    logger.info({ event: 'ignored' }, 'below threshold');
    logger.warn({ event: 'kept' }, 'at threshold');

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(line.event).toBe('kept');
  });
});
