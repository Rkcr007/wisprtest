import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AdminAuditList, AdminPolicy, AdminUser } from '../admin/schema';
import { AdminPanel } from '../components/admin-panel';
import { MemoryExplorer } from '../components/memory-explorer';
import { SessionsList } from '../components/sessions-list';

/**
 * Screen-level journeys the masthead actually opens.
 *
 * These render the same components the Server Components hand data to. They are not a browser
 * against Dex — Chrome policy on this machine cannot load the unpacked extension, and the
 * console's signed-in path needs a real session. What they prove is that a tester can move
 * from a list to a scoped view without invented numbers.
 */

const APP = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SCREEN = '55555555-5555-4555-8555-555555555551';

describe('console screens', () => {
  it('lets a tester scope Memory from a screen to its elements', () => {
    render(
      <MemoryExplorer
        applicationId={APP}
        selectedScreenId={null}
        screens={{
          applicationId: APP,
          memoryVersionId: '44444444-4444-4444-8444-444444444441',
          total: 1,
          screens: [
            {
              id: SCREEN,
              memoryVersionId: '44444444-4444-4444-8444-444444444441',
              routePattern: '/orders',
              stateFingerprint: 'a'.repeat(64),
              label: 'Orders list',
              structuralHash: 'b'.repeat(64),
              indexedAt: '2026-08-02T10:00:00.000Z',
            },
          ],
        }}
        elements={{ applicationId: APP, memoryVersionId: null, elements: [], total: 0 }}
        graph={{ applicationId: APP, memoryVersionId: null, edges: [] }}
        aliases={{ applicationId: APP, memoryVersionId: null, aliases: [], total: 0 }}
      />,
    );

    expect(screen.getByRole('link', { name: 'Orders list' }).getAttribute('href')).toBe(
      `/applications/${APP}/memory?screenId=${SCREEN}`,
    );
  });

  it('pages Sessions without inventing rows', () => {
    render(
      <SessionsList
        applicationId={APP}
        offset={0}
        limit={50}
        listed={{ sessions: [], total: 0 }}
      />,
    );
    expect(screen.getByText('No sessions yet.')).toBeDefined();
    expect(screen.queryByText(/coverage/i)).toBeNull();
  });

  it('shows Admin policy as read-only and never offers a speculate toggle', () => {
    const users: AdminUser[] = [
      {
        id: '22222222-2222-4222-8222-222222222221',
        email: 'priya.lead@northwind.example',
        role: 'owner',
        createdAt: '2026-08-02T10:00:00.000Z',
      },
    ];
    const policy: AdminPolicy = {
      writable: false,
      roles: ['viewer', 'tester', 'lead', 'owner'],
      permissionsByRole: { owner: ['admin:manage'] },
      reversibility: [
        { class: 'R', meaning: 'read-only', speculative: true, confirmation: false },
        { class: 'C', meaning: 'mutation', speculative: false, confirmation: true },
      ],
      redaction: {
        stores: 'structure, never content',
        accessibleNames: 'hashed',
        masks: ['email'],
        elementTextInLogs: false,
        customerDataInModelPrompts: false,
        writable: false,
      },
    };
    const audit: AdminAuditList = { entries: [], total: 0 };

    render(<AdminPanel users={users} policy={policy} audit={audit} />);

    expect(screen.getByText(/Not writable/)).toBeDefined();
    expect(screen.getByText('never')).toBeDefined();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
