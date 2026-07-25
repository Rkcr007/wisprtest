-- `updated_at` maintenance.
--
-- The column is set by the database, not by the caller. An application that forgets the column
-- would otherwise leave a stale timestamp behind, and "when did this row last change" is
-- exactly the question you ask when something has gone wrong — it has to be true.
--
-- ## Which tables get one, and which deliberately do not
--
-- Triggers are attached where a row is *expected* to mutate in place:
--
--   tenants, users, applications  — administrative edits
--   memory_versions               — status transitions, approval
--   aliases                       — `hits` increments on every T0 hit
--   entity_schemas, field_specs   — re-observation refines confidence and distributions
--   materializers                 — verification refreshes `verified_at`
--   sessions                      — closing sets `ended_at`
--   seed_ledger                   — reverting sets `reverted_at`
--   drift_reports                 — review sets status, approver and diff
--
-- Deliberately absent, because these tables are append-only:
--
--   screens, elements, nav_edges  — a memory version is rebuilt, never edited. Re-indexing
--                                   creates a new version, which is what makes a rollback a
--                                   pointer change rather than a data repair.
--   session_steps                 — the evidence trail. A step that could be updated after the
--                                   fact would not be evidence.
--   audit_log                     — same, and more so.
--
-- A row in one of those tables carries `created_at` alone. That is not an omission; adding
-- `updated_at` there would imply an edit path that must not exist.

CREATE FUNCTION set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    -- `now()` is the transaction timestamp, so every row touched by one statement agrees.
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
    'Sets NEW.updated_at on UPDATE. Attached only to tables where in-place mutation is expected; '
    'append-only tables (session_steps, audit_log, screens, elements, nav_edges) have no '
    'updated_at column at all.';

CREATE TRIGGER tenants_set_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER applications_set_updated_at
    BEFORE UPDATE ON applications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER memory_versions_set_updated_at
    BEFORE UPDATE ON memory_versions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER aliases_set_updated_at
    BEFORE UPDATE ON aliases
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER entity_schemas_set_updated_at
    BEFORE UPDATE ON entity_schemas
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER field_specs_set_updated_at
    BEFORE UPDATE ON field_specs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER materializers_set_updated_at
    BEFORE UPDATE ON materializers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER sessions_set_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER seed_ledger_set_updated_at
    BEFORE UPDATE ON seed_ledger
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER drift_reports_set_updated_at
    BEFORE UPDATE ON drift_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
