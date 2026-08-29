import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ApplicationRecord } from '../applications/schema';
import { Overview } from './overview';

const APPLICATION: ApplicationRecord = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  tenantId: '11111111-1111-4111-8111-111111111111',
  name: 'Orders',
  baseUrl: 'https://orders.example',
  env: 'staging',
  createdAt: '2026-08-02T10:00:00.000Z',
  memoryVersion: 1,
  memoryVersionId: '44444444-4444-4444-8444-444444444441',
  indexedAt: '2026-08-02T10:00:00.000Z',
  screenCount: 3,
  elementCount: 9,
  openDriftCount: 2,
};

describe('Overview', () => {
  it('renders counts from the active version and links open drift', () => {
    render(
      <Overview
        application={APPLICATION}
        sessions={{
          total: 1,
          sessions: [
            {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              tenantId: APPLICATION.tenantId,
              applicationId: APPLICATION.id,
              memoryVersionId: APPLICATION.memoryVersionId ?? APPLICATION.id,
              userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              startedAt: '2026-08-02T11:00:00.000Z',
              endedAt: null,
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
    expect(screen.getByText('open drift')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Review open drift' }).getAttribute('href')).toBe(
      `/applications/${APPLICATION.id}/drift`,
    );
    expect(screen.getByRole('link', { name: /aaaaaaaa-aaaa/ }).getAttribute('href')).toContain(
      '/sessions/',
    );
  });
});
