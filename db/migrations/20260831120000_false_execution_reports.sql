-- A tester's report that a step acted on the wrong thing.
--
-- The missing producer for `wispr_false_execution_total`. CLAUDE.md gates every release on a
-- false execution rate under 0.1%, and until now nothing in the product could produce the
-- numerator: a false execution is not something the runtime can detect, because by definition
-- the resolver was confident and the dispatch succeeded. Only the human watching the screen
-- knows. This table is where they say so.
--
-- ## Why a separate table and not a column on session_steps
--
-- `session_steps` is append-only (20260725120001_updated_at_triggers.sql: "a step that could be
-- updated after the fact would not be evidence"), and its `outcome` CHECK pins the five
-- dispatch-time outcomes. A step's outcome is what happened when the action fired; falseness is
-- a judgement made afterwards, by a person, sometimes days later. Writing it back onto the step
-- would let the timeline be revised by anyone who disagreed with it, which is precisely what the
-- append-only rule exists to prevent. `packages/protocol` models this the same way — a
-- `FalseExecutionReport` adjacent to the step, not a sixth `ActionOutcome`.
--
-- This table is append-only for the same reason, and so takes no `updated_at` and no
-- `set_updated_at` trigger. A withdrawal fills columns that were empty; it never rewrites who
-- filed the report or when. The row after a withdrawal still says everything it said before.

CREATE TABLE false_execution_reports (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL,
    session_id          uuid        NOT NULL,
    -- Identifies the step within the session. Not a foreign key to session_steps: that table's
    -- identity for this purpose is `(session_id, ordinal)`, which the route verifies exists
    -- before inserting. A composite FK would additionally have to carry tenant_id and would buy
    -- nothing the session FK below does not already guarantee.
    step_ordinal        integer     NOT NULL CHECK (step_ordinal >= 0),
    reason              text        NOT NULL,
    -- What the tester says should have been acted on, when they know. Set null rather than
    -- cascading, exactly as session_steps.element_id is: a report must survive an approved drift
    -- report removing the element it names.
    expected_element_id uuid,
    -- Already redacted. A tester describing what went wrong may name what is on the screen, so
    -- this is held to the same rule as session_steps.utterance (CLAUDE.md, PII rule).
    note                text,
    status              text        NOT NULL DEFAULT 'open',
    reported_by         uuid        NOT NULL,
    reported_at         timestamptz NOT NULL DEFAULT now(),
    -- Nulled if that account is later deleted; see the CHECK below for why it is not what proves
    -- a withdrawal happened.
    withdrawn_by        uuid,
    withdrawn_at        timestamptz,
    withdrawn_reason    text,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT false_execution_reports_reason_check
        CHECK (reason IN ('wrong_element', 'wrong_action', 'unintended_state_change')),
    CONSTRAINT false_execution_reports_status_check
        CHECK (status IN ('open', 'withdrawn')),

    -- A withdrawal is proved by `withdrawn_at` and `withdrawn_reason`, and deliberately NOT by
    -- `withdrawn_by`.
    --
    -- This is the lesson of 20260806120000_drift_decision_survives_user_deletion.sql, which
    -- existed because the original `drift_reports` CHECK required `approved_by IS NOT NULL` on a
    -- decided report while the FK nulled that column on user deletion. The two could not both
    -- hold, so *offboarding a user* failed with a constraint violation naming a table the
    -- operator was not touching. Naming `withdrawn_by` here would rebuild that trap exactly.
    --
    -- The property being reached for is not lost: a withdrawal moves a number that gates
    -- releases, so the gateway writes it to `audit_log` (ARCHITECTURE 8), which is never nulled.
    -- `withdrawn_by` stays as the convenient join; `withdrawn_at` is what carries the claim.
    CONSTRAINT false_execution_reports_withdrawal_is_complete
        CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL)),

    CONSTRAINT false_execution_reports_session_fkey
        FOREIGN KEY (session_id, tenant_id)
        REFERENCES sessions (id, tenant_id) ON DELETE CASCADE,
    -- CASCADE, matching sessions_user_fkey. Deleting a user already cascades away their sessions
    -- and therefore their steps, so a report that outlived them would reference a timeline that
    -- no longer exists — and the release-gate rate would keep a numerator whose denominator had
    -- gone. Both sides disappear together or the ratio lies.
    CONSTRAINT false_execution_reports_reported_by_fkey
        FOREIGN KEY (reported_by, tenant_id)
        REFERENCES users (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT false_execution_reports_withdrawn_by_fkey
        FOREIGN KEY (withdrawn_by, tenant_id)
        REFERENCES users (id, tenant_id) ON DELETE SET NULL (withdrawn_by),
    CONSTRAINT false_execution_reports_expected_element_fkey
        FOREIGN KEY (expected_element_id, tenant_id)
        REFERENCES elements (id, tenant_id) ON DELETE SET NULL (expected_element_id)
);

-- One *open* report per step, while still allowing a re-file after a withdrawal. A plain unique
-- index on (session_id, step_ordinal) would make a mistaken report permanent: withdraw it and the
-- step could never be reported again, which turns a mis-tap into lost gate data.
CREATE UNIQUE INDEX false_execution_reports_open_step_key
    ON false_execution_reports (session_id, step_ordinal)
    WHERE status = 'open';

-- The read path: every report on one session's timeline, in step order.
CREATE INDEX false_execution_reports_session_idx
    ON false_execution_reports (session_id, step_ordinal);

-- Per the "Indexes supporting the policy predicate" section of 20260725120002: every read below
-- carries an implicit `tenant_id = …`, so the predicate should be an index scan.
CREATE INDEX false_execution_reports_tenant_idx
    ON false_execution_reports (tenant_id);

-- Row-level security, written out rather than applied through `apply_tenant_policy`.
--
-- That procedure was dropped at the end of 20260725120002_row_level_security.sql, so this is the
-- first table since the core schema to need its own policy. What follows is exactly what the
-- procedure emitted, and the FORCE is the half that is easy to omit and expensive to miss:
-- without it the table's owner — which is what migrations and any superuser-ish connection run
-- as — reads straight across tenants.
ALTER TABLE false_execution_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE false_execution_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON false_execution_reports
    USING (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

-- 20260725120002 granted `ON ALL TABLES IN SCHEMA public`, which covers the tables that existed
-- when it ran and nothing since; there is no ALTER DEFAULT PRIVILEGES behind it. So a new table
-- needs its own grant or every query against it fails as wispr_app. Same verbs as that grant —
-- append-only is a property of the code path and the absence of a delete route, exactly as it is
-- for session_steps and audit_log, not something spelled differently here.
GRANT SELECT, INSERT, UPDATE, DELETE ON false_execution_reports TO wispr_app;

COMMENT ON TABLE false_execution_reports IS
    'A tester''s judgement that one session step acted wrongly. Append-only: a withdrawal fills '
    'the withdrawn_* columns and never rewrites who filed the report. Numerator of the false '
    'execution rate CLAUDE.md gates releases on.';

COMMENT ON COLUMN false_execution_reports.withdrawn_by IS
    'The human who withdrew, nulled if that account is later deleted. The durable record is '
    'audit_log (ARCHITECTURE 8); withdrawn_at is what proves a withdrawal was taken at all.';
