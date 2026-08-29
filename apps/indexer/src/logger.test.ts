import { describe, expect, it } from 'vitest';

import { createLogger, REDACTED_LOG_KEYS } from './logger.js';

function capture(): {
  readonly lines: string[];
  readonly destination: { write(chunk: string): void };
} {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write(chunk: string): void {
        lines.push(chunk);
      },
    },
  };
}

function logger(destination: { write(chunk: string): void }): ReturnType<typeof createLogger> {
  return createLogger(
    { service: 'indexer', level: 'info', env: 'test', workerId: 'worker-1' },
    destination,
  );
}

describe('createLogger', () => {
  it('emits structured worker identity without customer content', () => {
    const { lines, destination } = capture();

    logger(destination).info({ event: 'worker.started' }, 'indexer started');

    const line = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(line).toMatchObject({
      service: 'indexer',
      env: 'test',
      worker_id: 'worker-1',
      event: 'worker.started',
      level: 'info',
    });
  });

  it('censors every customer-content key at multiple nesting depths', () => {
    const marker = 'Acme Confidential 42';
    const { lines, destination } = capture();
    const sensitive = Object.fromEntries(REDACTED_LOG_KEYS.map((key) => [key, marker]));

    logger(destination).info(
      {
        ...sensitive,
        element: sensitive,
        candidate: { element: sensitive },
        result: { candidate: { element: sensitive } },
      },
      'redaction probe',
    );

    const serialized = lines[0] ?? '';
    expect(serialized).not.toContain(marker);
    expect(serialized).toContain('[redacted]');
  });

  it('censors authorization and cookie headers', () => {
    const marker = 'Bearer secret-customer-token';
    const { lines, destination } = capture();

    logger(destination).info(
      {
        req: { headers: { authorization: marker, cookie: marker } },
        headers: { authorization: marker },
      },
      'request probe',
    );

    expect(lines[0]).not.toContain(marker);
  });
});
