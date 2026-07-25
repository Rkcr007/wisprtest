import { describe, expect, it } from 'vitest';

import { ForbiddenError } from '../errors.js';
import {
  assertPermission,
  isRole,
  minimumRoleFor,
  PERMISSIONS,
  PERMISSIONS_BY_ROLE,
  roleHasPermission,
  ROLES,
  type Permission,
} from './permissions.js';

describe('the role vocabulary', () => {
  it('is the four roles from the data model', () => {
    expect([...ROLES].sort()).toEqual(['lead', 'owner', 'tester', 'viewer']);
  });

  it('recognises exactly those and nothing else', () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    for (const value of ['admin', 'superuser', '', null, undefined, 42]) {
      expect(isRole(value)).toBe(false);
    }
  });
});

describe('the policy is cumulative', () => {
  it.each([
    ['tester', 'viewer'],
    ['lead', 'tester'],
    ['owner', 'lead'],
  ] as const)('%s holds everything %s holds', (higher, lower) => {
    // A policy where a tester could do something their lead could not would surface as a
    // baffling 403 in production. `permissions.ts` asserts this at module load too; this is the
    // readable statement of the same property.
    for (const permission of PERMISSIONS_BY_ROLE[lower]) {
      expect(roleHasPermission(higher, permission)).toBe(true);
    }
  });

  it('gives each role strictly more than the one below it', () => {
    // Cumulative but not identical: two roles with the same permissions would mean one of them
    // is decorative.
    for (let i = 1; i < ROLES.length; i += 1) {
      const lower = ROLES[i - 1];
      const higher = ROLES[i];
      if (lower === undefined || higher === undefined) continue;

      expect(PERMISSIONS_BY_ROLE[higher].length).toBeGreaterThan(PERMISSIONS_BY_ROLE[lower].length);
    }
  });
});

describe('every permission is reachable', () => {
  it('is held by at least one role', () => {
    // An unreachable permission is a route nobody can call, which is a bug that only shows up
    // when somebody tries.
    for (const permission of PERMISSIONS) {
      const holders = ROLES.filter((role) => roleHasPermission(role, permission));
      expect(holders.length, `${permission} is held by no role`).toBeGreaterThan(0);
    }
  });

  it('names the least privileged role that holds it', () => {
    expect(minimumRoleFor('memory:read')).toBe('viewer');
    expect(minimumRoleFor('seed:plan')).toBe('tester');
    expect(minimumRoleFor('seed:execute')).toBe('lead');
    expect(minimumRoleFor('admin:manage')).toBe('owner');
  });
});

describe('the specific decisions worth stating', () => {
  it('lets a tester compose a plan but not execute one', () => {
    // Seeding is action class S: it writes to the customer's application, and the reversibility
    // taxonomy requires an approved preview. Composing writes nothing, so a tester can.
    expect(roleHasPermission('tester', 'seed:plan')).toBe(true);
    expect(roleHasPermission('tester', 'seed:execute')).toBe(false);
  });

  it('reserves memory and drift approval for lead and above', () => {
    // "WisprTest proposes; a human commits" — and specifically a human senior enough to.
    for (const permission of ['memory:approve', 'drift:approve'] as const) {
      expect(roleHasPermission('viewer', permission)).toBe(false);
      expect(roleHasPermission('tester', permission)).toBe(false);
      expect(roleHasPermission('lead', permission)).toBe(true);
      expect(roleHasPermission('owner', permission)).toBe(true);
    }
  });

  it('gives a viewer read access and nothing else', () => {
    expect(PERMISSIONS_BY_ROLE.viewer).toEqual(['memory:read']);
  });

  it('reserves administration for the owner alone', () => {
    expect(ROLES.filter((role) => roleHasPermission(role, 'admin:manage'))).toEqual(['owner']);
  });
});

describe('assertPermission', () => {
  it('permits what the role holds', () => {
    expect(() => {
      assertPermission('lead', 'seed:execute');
    }).not.toThrow();
  });

  it('throws a ForbiddenError naming the role the caller would need', () => {
    // A 403 that says only "no" makes the caller file a bug. One that names the role they need
    // tells them what to ask for.
    try {
      assertPermission('tester', 'seed:execute');
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).details).toMatchObject({
        permission: 'seed:execute',
        requiredRole: 'lead',
      });
    }
  });

  it('refuses every permission a viewer does not hold', () => {
    const withheld = PERMISSIONS.filter(
      (permission: Permission) => !roleHasPermission('viewer', permission),
    );
    expect(withheld.length).toBeGreaterThan(0);

    for (const permission of withheld) {
      expect(() => {
        assertPermission('viewer', permission);
      }).toThrow(ForbiddenError);
    }
  });
});
