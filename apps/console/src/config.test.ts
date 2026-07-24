import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';

const validEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  CONSOLE_PORT: '3000',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a complete environment and coerces the port', () => {
    expect(loadConfig(validEnv).CONSOLE_PORT).toBe(3000);
  });

  it('refuses to boot without a port', () => {
    const { CONSOLE_PORT: _port, ...partial } = validEnv;

    try {
      loadConfig(partial);
      expect.unreachable('loadConfig should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join('\n')).toContain('CONSOLE_PORT');
    }
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ ...validEnv, CONSOLE_PORT: 'three thousand' })).toThrow(ConfigError);
  });
});
