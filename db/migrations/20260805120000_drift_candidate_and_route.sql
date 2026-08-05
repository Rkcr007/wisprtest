-- What a drift report needs in order to be acted on: a version to activate, and a place to go.
--
-- docs/BUILD-PLAN.md Phase 17. Both columns exist because of one decision, recorded in
-- packages/protocol/src/drift.ts: **the indexer builds the next memory version, and a human
-- activates it.** Approval is a status change, not a rewrite of memory.
--
-- ## Why approval cannot apply the diff itself
--
-- `StructuralDiff.added` is an `ElementAddition`: an element key, a role, a redacted accessible
-- name and a landmark path. That is what a human needs in order to review a proposal, and it is
-- nowhere near enough to write an `elements` row, whose `fingerprint` is NOT NULL. Putting the
-- fingerprint in the diff would solve that by putting machine data in the one field whose whole
-- purpose is being readable — and would have the gateway reimplementing the element writing the
-- indexer already does correctly on every crawl.
--
-- So the reconcile clones the active version, applies what it observed, and leaves the clone
-- `building`. This column is the pointer to it. Everything needed for that already existed:
-- `memory_versions.status` has a `building` state, `approved_by` is documented as null until a
-- human approves activation, and `memory_versions_one_active_per_application` is a *partial*
-- unique index over `status = 'active'` — so a candidate sits beside the live version rather
-- than competing with it.
--
-- ## Why the observed route is stored rather than passed through
--
-- A reconcile has to navigate somewhere, and `route_pattern` is `/orders/:id`, which is not
-- somewhere. The gateway enqueues the job when the report is raised and could hand the concrete
-- path straight to Redis without ever persisting it — but a job lost to a Redis restart would
-- then strand the report `open` with nothing able to re-enqueue it, because the only copy of the
-- path went with the job.
--
-- It holds an identifier in a URL, the same class of value `seed_ledger.payload` already carries
-- for the same reason: a delete cannot be aimed at a record whose path nobody kept.

ALTER TABLE drift_reports
    ADD COLUMN candidate_memory_version_id uuid,
    ADD COLUMN observed_route text NOT NULL DEFAULT '/' CHECK (observed_route ~ '^/');

-- Composite, so a candidate version cannot belong to another tenant. The same shape every other
-- cross-table reference in this schema uses, and the reason `memory_versions_id_tenant_key`
-- exists at all.
--
-- ON DELETE SET NULL rather than CASCADE: if the candidate version is dropped, the report is
-- still the record that drift was observed and reviewed. Deleting the report along with it would
-- erase the evidence and leave the next reconcile to rediscover the same change from scratch.
--
-- Note how this composes with the CHECK below: nulling the column under a `diffed` report violates
-- it, so deleting a memory version that a *pending* decision depends on fails outright. That is
-- the intended behaviour and worth knowing before writing a retention job — such a job has to
-- resolve the reports pointing at a version before it can remove one.
ALTER TABLE drift_reports
    ADD CONSTRAINT drift_reports_candidate_version_fkey
        FOREIGN KEY (candidate_memory_version_id, tenant_id)
        REFERENCES memory_versions (id, tenant_id) ON DELETE SET NULL (candidate_memory_version_id);

-- The two states that mean "nobody has reconciled this yet" cannot already name a candidate, and
-- a report carrying a reviewable diff must name the version approving it would activate. Enforced
-- here as well as in the contract because this is the constraint that stops an approval from
-- activating nothing, and a CHECK is the only version of it that holds under concurrency.
ALTER TABLE drift_reports
    ADD CONSTRAINT drift_reports_candidate_matches_status CHECK (
        CASE status
            WHEN 'open'        THEN candidate_memory_version_id IS NULL
            WHEN 'reconciling' THEN candidate_memory_version_id IS NULL
            WHEN 'diffed'      THEN candidate_memory_version_id IS NOT NULL
            ELSE true
        END
    );

-- The default exists only to admit the rows already in the table; a report written from here on
-- always carries the route it was observed at. Dropped immediately so the column cannot silently
-- accept a report that forgot to say where the drift was.
ALTER TABLE drift_reports
    ALTER COLUMN observed_route DROP DEFAULT;

COMMENT ON COLUMN drift_reports.candidate_memory_version_id IS
    'The building memory version a reconcile produced, which approving this report activates. '
    'Null until reconciliation has built one. Approval flips its status rather than editing '
    'memory in place, so a session resolving against the current version keeps working.';

COMMENT ON COLUMN drift_reports.observed_route IS
    'The concrete path the drift was seen at, e.g. /orders/4903. Kept because route_pattern '
    'cannot be navigated to and a reconcile job lost to a Redis restart must be re-enqueueable.';
