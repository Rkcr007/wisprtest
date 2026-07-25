-- Row-level security: tenant isolation enforced by the database, not by application code.
--
-- CLAUDE.md rule #7 — "Every table has `tenant_id`. Every query is scoped." A query that
-- forgets its `WHERE tenant_id = …` is a bug that application-level scoping cannot prevent and
-- that no amount of code review reliably catches. Here it returns zero rows instead.
--
-- ## How a connection declares its tenant
--
--   SET LOCAL wispr.tenant_id = '<uuid>';
--
-- `SET LOCAL` scopes the setting to the current transaction, so a pooled connection cannot leak
-- one request's tenant into the next. Phase 4 sets it from an AsyncLocalStorage context on
-- checkout; nothing else is permitted to.
--
-- ## Fail-closed
--
-- `app_current_tenant_id()` returns NULL when the setting is unset *or* empty, and every policy
-- compares `tenant_id = app_current_tenant_id()`. A NULL comparison is NULL, which is not true,
-- so the row is filtered. Forgetting to set the tenant yields an empty result — never the whole
-- table. The `nullif` matters: `''::uuid` raises rather than returning NULL, and an exception
-- inside a policy is a much worse failure mode than an empty set.
--
-- ## Why `FORCE`, and why the tests use `SET ROLE`
--
-- A table's owner bypasses its own policies unless `FORCE ROW LEVEL SECURITY` is set. Superusers
-- and roles with BYPASSRLS bypass them regardless — that cannot be switched off.
--
-- The Docker Compose Postgres runs migrations as a superuser, so a test connecting with
-- `DATABASE_URL` would silently see every tenant's rows and prove nothing at all. `wispr_app`
-- below exists for that reason: a NOLOGIN role with DML rights and no bypass. Both the RLS
-- integration test and, from Phase 4, the gateway's connection pool `SET ROLE wispr_app` before
-- doing any work, which is the only configuration under which these policies actually apply.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The application role
-- ─────────────────────────────────────────────────────────────────────────────────────────────

-- Postgres has no `CREATE ROLE IF NOT EXISTS`, and roles are cluster-scoped so they survive a
-- `make db-reset` that drops only the database.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wispr_app') THEN
        -- NOLOGIN: reached only through `SET ROLE` from an already-authenticated connection.
        -- There is no password, so there is no credential to leak or to commit.
        CREATE ROLE wispr_app NOLOGIN;
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO wispr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wispr_app;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The tenant of the current transaction
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION app_current_tenant_id() RETURNS uuid
    LANGUAGE sql
    STABLE
    PARALLEL SAFE
AS $$
    SELECT nullif(current_setting('wispr.tenant_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION app_current_tenant_id() IS
    'Tenant of the current transaction, from the wispr.tenant_id setting. NULL when unset or '
    'empty, which makes every RLS policy fail closed.';

GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO wispr_app;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Policies
-- ─────────────────────────────────────────────────────────────────────────────────────────────
--
-- One policy per table, covering ALL commands. `USING` filters what an existing row is visible
-- to; `WITH CHECK` governs what a new or updated row may become. Both are required: `USING`
-- alone would let a tenant insert a row belonging to somebody else, which it could then not see
-- — a write it cannot audit is worse than a read it cannot perform.

CREATE OR REPLACE PROCEDURE apply_tenant_policy(target regclass)
    LANGUAGE plpgsql
AS $$
BEGIN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    -- FORCE so that the owner is subject to its own policies too. Without it, anything running
    -- as the migration user reads across tenants.
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
        'CREATE POLICY tenant_isolation ON %s '
        'USING (tenant_id = app_current_tenant_id()) '
        'WITH CHECK (tenant_id = app_current_tenant_id())',
        target
    );
END;
$$;

CALL apply_tenant_policy('users');
CALL apply_tenant_policy('applications');
CALL apply_tenant_policy('memory_versions');
CALL apply_tenant_policy('screens');
CALL apply_tenant_policy('elements');
CALL apply_tenant_policy('nav_edges');
CALL apply_tenant_policy('aliases');
CALL apply_tenant_policy('entity_schemas');
CALL apply_tenant_policy('field_specs');
CALL apply_tenant_policy('materializers');
CALL apply_tenant_policy('sessions');
CALL apply_tenant_policy('session_steps');
CALL apply_tenant_policy('seed_ledger');
CALL apply_tenant_policy('drift_reports');
CALL apply_tenant_policy('audit_log');

DROP PROCEDURE apply_tenant_policy(regclass);

-- `tenants` is the one table whose own primary key *is* the tenant, so it cannot go through the
-- procedure above: that policy names a `tenant_id` column, and creating it here would fail with
-- "column tenant_id does not exist" rather than merely being wrong.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
    USING (id = app_current_tenant_id())
    WITH CHECK (id = app_current_tenant_id());

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Indexes supporting the policy predicate
-- ─────────────────────────────────────────────────────────────────────────────────────────────
--
-- Every read now carries an implicit `tenant_id = …`. Tables whose other indexes do not already
-- lead with `tenant_id` get one, so the predicate is an index scan rather than a filter applied
-- after the fact.

CREATE INDEX users_tenant_idx ON users (tenant_id);
CREATE INDEX applications_tenant_idx ON applications (tenant_id);
CREATE INDEX memory_versions_tenant_idx ON memory_versions (tenant_id);
CREATE INDEX screens_tenant_idx ON screens (tenant_id);
CREATE INDEX elements_tenant_idx ON elements (tenant_id);
CREATE INDEX nav_edges_tenant_idx ON nav_edges (tenant_id);
CREATE INDEX entity_schemas_tenant_idx ON entity_schemas (tenant_id);
CREATE INDEX field_specs_tenant_idx ON field_specs (tenant_id);
CREATE INDEX materializers_tenant_idx ON materializers (tenant_id);
CREATE INDEX session_steps_tenant_idx ON session_steps (tenant_id);
CREATE INDEX drift_reports_tenant_idx ON drift_reports (tenant_id);
