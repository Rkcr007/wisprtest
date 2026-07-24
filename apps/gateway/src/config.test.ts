import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';

const validEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  GATEWAY_HOST: '127.0.0.1',
  GATEWAY_PORT: '8080',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a complete environment and coerces the port to a number', () => {
    const config = loadConfig(validEnv);

    expect(config.GATEWAY_HOST).toBe('127.0.0.1');
    expect(config.GATEWAY_PORT).toBe(8080);
    expect(config.NODE_ENV).toBe('development');
  });

  it('names every missing variable, not just the first', () => {
    const { GATEWAY_HOST: _host, GATEWAY_PORT: _port, ...partial } = validEnv;

    expect(() => loadConfig(partial)).toThrow(ConfigError);

    try {
      loadConfig(partial);
      expect.unreachable('loadConfig should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join('\n');
      expect(issues).toContain('GATEWAY_HOST');
      expect(issues).toContain('GATEWAY_PORT');
    }
  });

  it('rejects a non-numeric port rather than defaulting', () => {
    expect(() => loadConfig({ ...validEnv, GATEWAY_PORT: 'not-a-port' })).toThrow(ConfigError);
  });

  it('rejects a port outside the valid range', () => {
    expect(() => loadConfig({ ...validEnv, GATEWAY_PORT: '70000' })).toThrow(ConfigError);
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: 'chatty' })).toThrow(ConfigError);
  });
});
