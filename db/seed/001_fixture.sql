-- Integration-test fixture: one tenant, two users of different roles, one application.
--
-- Loaded by `make db-seed` and by `pnpm --filter gateway test:db`. Ids are fixed rather than
-- generated so a test can assert against them without reading them back first, and so a failing
-- test names a row you can go and look at.
--
-- A second tenant is included as well. It exists for exactly one purpose: the RLS test needs a
-- neighbour to fail to see. A tenant-isolation test with only one tenant in the database proves
-- that scoping works, not that isolation does — the query would return the right rows either
-- way. `db/seed/002_rls_neighbour.sql` holds it, so this file stays the plain fixture the phase
-- asked for.
--
-- Idempotent: every insert is `ON CONFLICT DO NOTHING`, so seeding twice is a no-op rather than
-- an error. `make db-reset` drops the database anyway, but a developer re-running the seed
-- against a live database should not have to think about it.
--
-- RLS: this file is executed by the migration user, which is a superuser in Compose and
-- therefore bypasses the policies. Where it is not, `SET LOCAL wispr.tenant_id` would be needed
-- per tenant. `make db-seed` runs it inside a transaction so either the whole fixture lands or
-- none of it does.

INSERT INTO tenants (id, name)
VALUES ('11111111-1111-4111-8111-111111111111', 'Northwind QA')
ON CONFLICT (id) DO NOTHING;

-- Two roles, deliberately at opposite ends of the permission map: `lead` may approve a memory
-- version and a drift report, `tester` may not. Phase 4's RBAC tests need both.
INSERT INTO users (id, tenant_id, email, role)
VALUES
    ('22222222-2222-4222-8222-222222222221',
     '11111111-1111-4111-8111-111111111111',
     'priya.lead@northwind.example',
     'lead'),
    ('22222222-2222-4222-8222-222222222222',
     '11111111-1111-4111-8111-111111111111',
     'daniel.tester@northwind.example',
     'tester')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, tenant_id, name, base_url, env)
VALUES
    ('33333333-3333-4333-8333-333333333331',
     '11111111-1111-4111-8111-111111111111',
     'Northwind Orders',
     'https://orders.northwind.example',
     'staging')
ON CONFLICT (id) DO NOTHING;

-- An active memory version, so tests that need a session or a snapshot have something to hang
-- them off. Version 1, approved by the lead — the only role that may.
INSERT INTO memory_versions (id, tenant_id, application_id, version, status, approved_by)
VALUES
    ('44444444-4444-4444-8444-444444444441',
     '11111111-1111-4111-8111-111111111111',
     '33333333-3333-4333-8333-333333333331',
     1,
     'active',
     '22222222-2222-4222-8222-222222222221')
ON CONFLICT (id) DO NOTHING;

INSERT INTO screens (
    id, tenant_id, memory_version_id, route_pattern, state_fingerprint, label, structural_hash
)
VALUES
    ('55555555-5555-4555-8555-555555555551',
     '11111111-1111-4111-8111-111111111111',
     '44444444-4444-4444-8444-444444444441',
     '/orders',
     repeat('a', 64),
     'Orders list',
     repeat('b', 64))
ON CONFLICT (id) DO NOTHING;

INSERT INTO elements (
    id, tenant_id, screen_id, element_key, role, accessible_name_hash,
    fingerprint, confidence, stability
)
VALUES
    ('66666666-6666-4666-8666-666666666661',
     '11111111-1111-4111-8111-111111111111',
     '55555555-5555-4555-8555-555555555551',
     'orders.filter.pending',
     'button',
     repeat('c', 64),
     -- Shaped as `ElementFingerprint` in `packages/protocol`. The accessible name appears only
     -- as a digest and a redacted display form; there is no raw-name field to populate.
     jsonb_build_object(
         'role', 'button',
         'tagName', 'button',
         'accessibleNameHash', repeat('c', 64),
         'accessibleNameRedacted', 'Pending',
         'landmarkPath', jsonb_build_array('main', 'region:orders'),
         'stableAttributes', jsonb_build_object('data-testid', 'filter-pending'),
         'ordinal', 0,
         'textShingleHash', repeat('d', 64),
         'bbox', jsonb_build_object('x', 0.1, 'y', 0.2, 'width', 0.12, 'height', 0.04)
     ),
     0.97,
     0.91)
ON CONFLICT (id) DO NOTHING;

INSERT INTO aliases (
    id, tenant_id, memory_version_id, phrase, element_id, state_fingerprint, source, hits
)
VALUES
    ('77777777-7777-4777-8777-777777777771',
     '11111111-1111-4111-8111-111111111111',
     '44444444-4444-4444-8444-444444444441',
     'the pending filter',
     '66666666-6666-4666-8666-666666666661',
     repeat('a', 64),
     'indexed',
     0)
ON CONFLICT (id) DO NOTHING;
