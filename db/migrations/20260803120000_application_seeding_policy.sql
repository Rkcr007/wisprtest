-- Per-application seeding policy: production is off unless someone turned it on, on the record.
--
-- docs/TEST-DATA-ENGINE.md § 7 lists the production environment as a failure mode to design
-- against — "blocked by policy unless explicitly and auditably enabled" — and § 1 lists the
-- environment policy as a *per-application* artifact, alongside the schemas and materializers.
-- That placement is the whole reason this is a column rather than a constant in the gateway:
-- a rule that lives in code is one rule for every customer, and the first customer who seeds
-- into a production-labelled sandbox turns it into an `if (app === …)`, which CLAUDE.md
-- § "What is generic vs what is per-application" forbids outright.
--
-- ## Enabling is a record, not a flag
--
-- Three columns move together: who enabled it, when, and why. A boolean would answer the
-- question the route asks and none of the questions asked afterwards — a security review wants
-- to know who signed off on writing to production and what they said about it, and "true" is not
-- an answer to that. The CHECK below makes a half-filled policy unrepresentable.
--
-- Enabling and disabling also land in `audit_log` like every other governed mutation
-- (docs/ARCHITECTURE.md § 8). These columns are the current state; the log is the history.
--
-- ## The rule itself lives here too
--
-- `seeding_allowed` is generated rather than computed by the caller. Two services already need
-- the answer — the gateway to enforce it and the console to render it — and a rule evaluated in
-- two places is a rule that eventually disagrees with itself. Generated from the same row it
-- describes, it cannot.
--
-- Deliberately one-directional: it enables production, it does not disable staging. Nobody has
-- asked to turn seeding off in an environment where it is the point, and inventing the surface
-- now would mean guessing at whether that is a per-application setting or a tenant-wide one.
-- Adding it later is another column, not a redesign.

ALTER TABLE applications
    ADD COLUMN seeding_enabled_at     timestamptz,
    ADD COLUMN seeding_enabled_by     uuid,
    ADD COLUMN seeding_enabled_reason text;

-- The instant and the justification move together: there is no such thing as a policy in force
-- with no stated reason, nor a reason for a policy that is not in force.
--
-- The approver is not part of that pair, and the FK below is why — deleting the account that
-- enabled seeding nulls this column, and a constraint demanding all three would turn that into a
-- failed `DELETE FROM users`. Requiring the triple would make the policy hold the account
-- hostage.
ALTER TABLE applications
    ADD CONSTRAINT applications_seeding_policy_complete CHECK (
        num_nonnulls(seeding_enabled_at, seeding_enabled_reason) IN (0, 2)
        AND (seeding_enabled_by IS NULL OR seeding_enabled_at IS NOT NULL)
    );

-- A justification of "" is the absence of one wearing its clothes.
ALTER TABLE applications
    ADD CONSTRAINT applications_seeding_reason_check CHECK (
        seeding_enabled_reason IS NULL OR length(btrim(seeding_enabled_reason)) > 0
    );

-- The approver is a user of the same tenant, proven by the composite key rather than trusted.
-- `SET NULL` on the column alone rather than the whole triple: a policy has to survive the
-- approver's account being deleted, because the audit question is what was enabled and when,
-- and losing the row would answer it with silence. Who signed off remains in `audit_log`.
ALTER TABLE applications
    ADD CONSTRAINT applications_seeding_enabled_by_fkey
        FOREIGN KEY (seeding_enabled_by, tenant_id)
        REFERENCES users (id, tenant_id) ON DELETE SET NULL (seeding_enabled_by);

ALTER TABLE applications
    ADD COLUMN seeding_allowed boolean
        GENERATED ALWAYS AS (env <> 'production' OR seeding_enabled_at IS NOT NULL) STORED;

COMMENT ON COLUMN applications.seeding_allowed IS
    'Whether /v1/seed/execute may write to this application. Production requires an explicit, '
    'audited opt-in; every other environment is allowed by default.';
