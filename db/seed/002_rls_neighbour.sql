-- A second tenant, whose only job is to be invisible.
--
-- A tenant-isolation test run against a database containing one tenant proves nothing: the
-- query returns the right rows whether the policy is working or not, because there are no other
-- rows to leak. The assertion that matters is "tenant A, correctly scoped, cannot see this" —
-- and that needs a *this*.
--
-- Kept separate from `001_fixture.sql` so that file remains the plain fixture Phase 3 describes:
-- one tenant, two users, one application.

INSERT INTO tenants (id, name)
VALUES ('99999999-9999-4999-8999-999999999999', 'Contoso QA')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, tenant_id, email, role)
VALUES
    ('88888888-8888-4888-8888-888888888881',
     '99999999-9999-4999-8999-999999999999',
     -- Deliberately the same local part as Northwind's lead. Email uniqueness is per tenant,
     -- and a test that only ever used distinct addresses would not notice if it were global.
     'priya.lead@contoso.example',
     'owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, tenant_id, name, base_url, env)
VALUES
    ('88888888-8888-4888-8888-888888888882',
     '99999999-9999-4999-8999-999999999999',
     -- Same application name as Northwind's, for the same reason.
     'Northwind Orders',
     'https://orders.contoso.example',
     'staging')
ON CONFLICT (id) DO NOTHING;

INSERT INTO memory_versions (id, tenant_id, application_id, version, status)
VALUES
    ('88888888-8888-4888-8888-888888888883',
     '99999999-9999-4999-8999-999999999999',
     '88888888-8888-4888-8888-888888888882',
     1,
     'building')
ON CONFLICT (id) DO NOTHING;
