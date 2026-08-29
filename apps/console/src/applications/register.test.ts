import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleError } from '../errors';
import type { ApplicationRecord } from './schema';

vi.mock('../gateway/client', () => ({
  callGatewayJson: vi.fn(),
}));

const APPLICATION: ApplicationRecord = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  tenantId: '11111111-1111-4111-8111-111111111111',
  name: 'Orders',
  baseUrl: 'https://app.example.com',
  env: 'staging',
  createdAt: '2026-08-02T10:00:00.000Z',
};

const session = { accessToken: 'token', expiresAt: Date.now() + 60_000 };
const body = { name: 'Orders', baseUrl: 'https://app.example.com', env: 'staging' as const };

describe('registerOrReuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the created row when the gateway accepts the register', async () => {
    const { callGatewayJson } = await import('../gateway/client');
    vi.mocked(callGatewayJson).mockResolvedValueOnce(APPLICATION);
    const { registerOrReuse } = await import('./register');

    await expect(registerOrReuse(session, body)).resolves.toEqual({
      created: true,
      application: APPLICATION,
    });
  });

  it('reuses the existing row when name and origin already match', async () => {
    const { callGatewayJson } = await import('../gateway/client');
    vi.mocked(callGatewayJson)
      .mockRejectedValueOnce(
        new ConsoleError('gateway_rejected', 'an application with this name already exists', {
          status: 400,
          wispr: {
            code: 'validation_failed',
            message: 'an application with this name already exists',
            retryable: false,
            issues: [{ path: 'name', message: 'an application with this name already exists' }],
          },
        }),
      )
      .mockResolvedValueOnce({
        tenantId: APPLICATION.tenantId,
        applications: [APPLICATION],
      });
    const { registerOrReuse } = await import('./register');

    await expect(registerOrReuse(session, body)).resolves.toEqual({
      created: false,
      application: APPLICATION,
    });
  });

  it('does not reuse a name that exists at a different origin', async () => {
    const { callGatewayJson } = await import('../gateway/client');
    const refusal = new ConsoleError('gateway_rejected', 'name taken', {
      status: 400,
      wispr: {
        code: 'validation_failed',
        message: 'name taken',
        retryable: false,
        issues: [{ path: 'name', message: 'name taken' }],
      },
    });
    vi.mocked(callGatewayJson)
      .mockRejectedValueOnce(refusal)
      .mockResolvedValueOnce({
        tenantId: APPLICATION.tenantId,
        applications: [{ ...APPLICATION, baseUrl: 'https://other.example.com' }],
      });
    const { registerOrReuse } = await import('./register');

    await expect(registerOrReuse(session, body)).rejects.toBe(refusal);
  });
});
