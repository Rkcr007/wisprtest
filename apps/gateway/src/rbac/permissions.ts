import { ForbiddenError } from '../errors.js';

/**
 * The permission map.
 *
 * Declarative on purpose. A permission expressed as `if (role === 'lead' || role === 'owner')`
 * scattered across handlers cannot be reviewed, cannot be rendered as the admin screen Phase 18
 * has to build, and drifts the moment somebody adds a role. Here the whole policy is one table
 * you can read top to bottom and hand to a security reviewer.
 *
 * The four roles come from the data model in docs/ARCHITECTURE.md § 4.
 *
 * ## The shape of the policy
 *
 * Roles are **cumulative**: every role holds everything the one below it holds, plus its own.
 * That is a real constraint, not an implementation detail — it means a lead can always do what
 * a tester can, so a permission cannot be granted to a tester and accidentally withheld from
 * the people who supervise them. `assertCumulative` proves it at module load.
 *
 * ## What each permission gates, and which phase enforces it
 *
 * | Permission              | Gates                                             | Phase |
 * |-------------------------|---------------------------------------------------|-------|
 * | `memory:read`           | snapshot load, memory browsing                     | 8     |
 * | `session:write`         | opening a session, ingesting steps                 | 12    |
 * | `alias:write`           | T2 write-back                                      | 11    |
 * | `seed:plan`             | composing a plan — writes nothing                  | 15    |
 * | `seed:execute`          | materializing a plan into the app under test       | 15    |
 * | `seed:revert`           | reverting seeded records                           | 15    |
 * | `application:register`  | registering an app and starting an index           | 5     |
 * | `memory:approve`        | activating a memory version                        | 17    |
 * | `drift:approve`         | approving a drift report                           | 17    |
 * | `admin:manage`          | team, RBAC, redaction policy, audit log            | 18    |
 *
 * `seed:execute` sits with lead and above deliberately. Seeding is action class **S** — it
 * writes to the customer's application, and CLAUDE.md's reversibility taxonomy requires an
 * approved preview before it happens. A viewer plainly cannot; a tester composing a plan and
 * needing a lead to approve execution is the same shape as the drift approval flow, and for the
 * same reason.
 */

export const ROLES = ['viewer', 'tester', 'lead', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'memory:read',
  'session:write',
  'alias:write',
  'seed:plan',
  'seed:execute',
  'seed:revert',
  'application:register',
  'memory:approve',
  'drift:approve',
  'admin:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Ordered least to most privileged. Index is the rank used by {@link minimumRoleFor}. */
const ROLE_RANK: Record<Role, number> = { viewer: 0, tester: 1, lead: 2, owner: 3 };

export const PERMISSIONS_BY_ROLE = {
  viewer: ['memory:read'],

  tester: ['memory:read', 'session:write', 'alias:write', 'seed:plan'],

  lead: [
    'memory:read',
    'session:write',
    'alias:write',
    'seed:plan',
    'seed:execute',
    'seed:revert',
    'application:register',
    'memory:approve',
    'drift:approve',
  ],

  owner: [
    'memory:read',
    'session:write',
    'alias:write',
    'seed:plan',
    'seed:execute',
    'seed:revert',
    'application:register',
    'memory:approve',
    'drift:approve',
    'admin:manage',
  ],
} as const satisfies Record<Role, readonly Permission[]>;

/**
 * Roles are cumulative, checked at module load rather than asserted in a comment.
 *
 * A policy where a tester could do something a lead could not would be a bug that only shows up
 * as a confusing 403 in production. This turns it into a process that will not start.
 */
function assertCumulative(): void {
  for (let i = 1; i < ROLES.length; i += 1) {
    const lower = ROLES[i - 1];
    const higher = ROLES[i];
    if (lower === undefined || higher === undefined) continue;

    const held = new Set<string>(PERMISSIONS_BY_ROLE[higher]);
    const missing = PERMISSIONS_BY_ROLE[lower].filter((permission) => !held.has(permission));

    if (missing.length > 0) {
      throw new Error(
        `RBAC policy is not cumulative: ${higher} is missing ${missing.join(', ')} held by ${lower}`,
      );
    }
  }
}

assertCumulative();

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return (PERMISSIONS_BY_ROLE[role] as readonly Permission[]).includes(permission);
}

/** The least privileged role holding `permission` — what a 403 should name to be actionable. */
export function minimumRoleFor(permission: Permission): Role {
  const holders = ROLES.filter((role) => roleHasPermission(role, permission));
  const [least] = holders.sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
  if (least === undefined) {
    throw new Error(`no role holds ${permission}; the permission map is unreachable`);
  }
  return least;
}

/**
 * Throw unless `role` holds `permission`.
 *
 * The error names the role the caller would need rather than merely refusing, so a tester who
 * hits a lead-only action is told what to ask for instead of filing a bug.
 */
export function assertPermission(role: Role, permission: Permission): void {
  if (!roleHasPermission(role, permission)) {
    throw new ForbiddenError(permission, minimumRoleFor(permission));
  }
}
