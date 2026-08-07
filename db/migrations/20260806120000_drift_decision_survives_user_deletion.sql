-- A decided drift report must survive the deletion of the person who decided it.
--
-- ## The contradiction
--
-- Two constraints added together in 20260725120000_core_schema.sql cannot both hold:
--
--   * `drift_reports_approved_by_fkey` is `ON DELETE SET NULL (approved_by)`, so deleting a user
--     nulls the approver rather than cascading the report away. That is right: a report is a
--     record of a decision about memory, and it must outlive the account that made it.
--   * `drift_reports_decision_needs_approver` required `approved_by IS NOT NULL` for any report
--     that is `approved` or `rejected`.
--
-- So the SET NULL writes a row the CHECK then rejects, and the *user deletion* fails. Not the
-- report — the user. An operator offboarding somebody who once approved a drift report gets a
-- constraint violation naming a table they were not touching, and a tenant with any decided
-- report could not be deleted at all.
--
-- Found by the indexer's drift suite: a fixture that decided a report could not drop its own
-- tenant afterwards, which is the same failure an offboarding would hit in production.
--
-- ## Why the CHECK is the side that gives
--
-- `packages/protocol` is the source of truth for this shape (CLAUDE.md rule #3), and its
-- `DriftReport` types `approvedBy` as `Uuid.nullable()` with refinements on
-- `candidateMemoryVersionId` and none tying the approver to the status. The database was
-- therefore *stricter than the contract*, and the stricter half is the one that could not be
-- satisfied.
--
-- The property the original CHECK was reaching for — a decision has a human behind it — is not
-- lost. docs/ARCHITECTURE.md § 8 makes `audit_log` the durable record: "every memory mutation,
-- seed, revert, and approval is written to audit_log", and unlike this column it is not nulled
-- when an account goes away. `approved_by` stays as the convenient join for the console's review
-- queue; `resolved_at` is what now carries the claim that a decision was actually taken, and it
-- is never nulled by anything.
--
-- What this does NOT do is open a path to an approval without a human. Nothing may set
-- `status = 'approved'` on its own: that remains the gateway's, gated on `drift:approve`, and
-- ADR 0007 still forbids an auto-approve path even behind a flag. This changes what the row must
-- still be able to say about a decision years later, not who is allowed to make one.

ALTER TABLE drift_reports
    DROP CONSTRAINT drift_reports_decision_needs_approver;

ALTER TABLE drift_reports
    ADD CONSTRAINT drift_reports_decision_needs_approver
        CHECK (status NOT IN ('approved', 'rejected') OR resolved_at IS NOT NULL);

COMMENT ON COLUMN drift_reports.approved_by IS
    'The human who approved or rejected, nulled if that account is later deleted. The durable '
    'record of who decided is audit_log (ARCHITECTURE 8); resolved_at is what proves a decision '
    'was taken at all.';
