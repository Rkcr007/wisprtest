import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';

const validEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  INDEXER_WORKER_ID: 'indexer-local-1',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a complete environment', () => {
    const config = loadConfig(validEnv);

    expect(config.INDEXER_WORKER_ID).toBe('indexer-local-1');
    expect(config.NODE_ENV).toBe('development');
  });

  it('refuses to start without a worker id rather than generating one', () => {
    const { INDEXER_WORKER_ID: _workerId, ...partial } = validEnv;

    try {
      loadConfig(partial);
      expect.unreachable('loadConfig should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join('\n')).toContain('INDEXER_WORKER_ID');
    }
  });

  it('rejects an empty worker id', () => {
    expect(() => loadConfig({ ...validEnv, INDEXER_WORKER_ID: '' })).toThrow(ConfigError);
  });

  it('rejects an unknown environment name', () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'staging' })).toThrow(ConfigError);
  });
});
