-- Core schema: tenancy, memory, entity schemas, seeding, sessions, governance.
--
-- Covers every table in docs/ARCHITECTURE.md § 4. Where that document and
-- `packages/protocol` differ, the protocol wins — it is the single source of truth for every
-- shape that crosses a boundary (CLAUDE.md rule #3), and the columns it adds are ones Phases
-- 12–17 would otherwise have to migrate in later.
--
-- ## Tenancy: `tenant_id` on every table, provably consistent with the owner
--
-- CLAUDE.md rule #7 requires `tenant_id` on every table and a scoped query for every read.
-- ARCHITECTURE § 4 permits carrying it "directly or via an owning row"; this schema carries it
-- directly everywhere, and then makes it impossible for the copy to drift:
--
--   screens.tenant_id  ──┐
--   screens.memory_version_id ──┴──►  memory_versions (id, tenant_id)   -- composite FK
--
-- Every child references its parent by `(parent_id, tenant_id)` against a `UNIQUE (id,
-- tenant_id)` on the parent. A row whose `tenant_id` disagrees with its owner's cannot be
-- inserted at all.
--
-- The alternative — policies that walk up the ownership chain with an `EXISTS` subquery — is
-- correct without the denormalisation, but it puts a correlated subquery on every row of every
-- read, including the memory snapshot load that the extension blocks on at attach. Denormalising
-- turns each policy into a single indexed equality.
--
-- ## Enum-like columns
--
-- Every one is a `text` column with a CHECK constraint rather than a native `enum` type: adding
-- a value to a Postgres enum is a schema migration that cannot run in a transaction alongside
-- other DDL on older servers, and the value sets here are owned by `packages/protocol`. The
-- constraint names are stable so `apps/gateway`'s schema test can read them back out of the
-- catalogue and compare them against the Zod enums — see `enum-parity.test.ts`.
--
-- ## Timestamps
--
-- `timestamptz` everywhere, UTC, per CLAUDE.md § "Conventions". `created_at` on every table;
-- `updated_at` only where a row is expected to mutate — see the triggers migration for which,
-- and why the others are append-only.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Tenancy
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE tenants (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL CHECK (length(btrim(name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    email      text        NOT NULL CHECK (position('@' IN email) > 1),
    role       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_role_check CHECK (role IN ('owner', 'lead', 'tester', 'viewer')),
    CONSTRAINT users_id_tenant_key UNIQUE (id, tenant_id)
);

-- Addresses are compared case-insensitively, and are unique within a tenant rather than
-- globally: the same person may legitimately hold accounts in two customers' tenants.
CREATE UNIQUE INDEX users_tenant_email_key ON users (tenant_id, lower(email));

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Applications and memory
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE applications (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    name       text        NOT NULL CHECK (length(btrim(name)) > 0),
    base_url   text        NOT NULL CHECK (base_url ~ '^https?://'),
    env        text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    -- Seeding policy keys off this column: production is blocked unless auditably enabled
    -- (docs/TEST-DATA-ENGINE.md § 7). A free-text environment would make that check unreliable.
    CONSTRAINT applications_env_check
        CHECK (env IN ('development', 'staging', 'production')),
    CONSTRAINT applications_id_tenant_key UNIQUE (id, tenant_id),
    CONSTRAINT applications_tenant_name_key UNIQUE (tenant_id, name)
);

CREATE TABLE memory_versions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid        NOT NULL,
    application_id uuid        NOT NULL,
    version        integer     NOT NULL CHECK (version >= 1),
    status         text        NOT NULL,
    -- Populated only when `status` is 'failed'; the CHECK below keeps the two in step.
    failure_reason text,
    -- Null until a human approves activation. There is no auto-approve path, by design
    -- (docs/BUILD-PLAN.md Phase 17). Kept on the row even if the approver's account is later
    -- deleted, because `audit_log` holds the durable record.
    approved_by    uuid,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT memory_versions_approved_by_fkey
        FOREIGN KEY (approved_by, tenant_id)
        REFERENCES users (id, tenant_id) ON DELETE SET NULL (approved_by),
    CONSTRAINT memory_versions_status_check
        CHECK (status IN ('building', 'active', 'superseded', 'failed')),
    CONSTRAINT memory_versions_failure_reason_check
        CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
    CONSTRAINT memory_versions_application_fkey
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT memory_versions_id_tenant_key UNIQUE (id, tenant_id)
);

-- The snapshot load path: `GET /v1/memory/:appId/snapshot` resolves an application to its
-- active version, then reads everything hanging off it. Named in docs/BUILD-PLAN.md Phase 3.
CREATE UNIQUE INDEX memory_versions_application_version_key
    ON memory_versions (application_id, version);

-- At most one active version per application. A partial unique index rather than a trigger:
-- the database enforces it under concurrency without anything to get wrong in application code.
CREATE UNIQUE INDEX memory_versions_one_active_per_application
    ON memory_versions (application_id) WHERE status = 'active';

CREATE TABLE screens (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid        NOT NULL,
    memory_version_id uuid        NOT NULL,
    route_pattern     text        NOT NULL CHECK (route_pattern ~ '^/'),
    state_fingerprint text        NOT NULL CHECK (state_fingerprint ~ '^[0-9a-f]{64}$'),
    label             text        NOT NULL CHECK (length(btrim(label)) > 0),
    structural_hash   text        NOT NULL CHECK (structural_hash ~ '^[0-9a-f]{64}$'),
    indexed_at        timestamptz NOT NULL DEFAULT now(),
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT screens_memory_version_fkey
        FOREIGN KEY (memory_version_id, tenant_id)
        REFERENCES memory_versions (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT screens_id_tenant_key UNIQUE (id, tenant_id),
    -- A screen *is* its state fingerprint: `/orders/:id` with a dialog open is a different
    -- screen from the same route without one, because a different set of elements is reachable.
    CONSTRAINT screens_version_fingerprint_key UNIQUE (memory_version_id, state_fingerprint)
);

CREATE INDEX screens_memory_version_idx ON screens (memory_version_id);

CREATE TABLE elements (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid    NOT NULL,
    screen_id            uuid    NOT NULL,
    -- `screen.component.element`, per CLAUDE.md § "Conventions".
    element_key          text    NOT NULL
        CHECK (element_key ~ '^[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*){2}$'),
    role                 text    NOT NULL CHECK (length(btrim(role)) > 0),
    -- PII rule: the name is stored as a digest plus a redacted display form inside
    -- `fingerprint`. The raw accessible name has no column here and never will.
    accessible_name_hash text    NOT NULL CHECK (accessible_name_hash ~ '^[0-9a-f]{64}$'),
    fingerprint          jsonb   NOT NULL,
    confidence           numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    stability            numeric NOT NULL CHECK (stability BETWEEN 0 AND 1),
    created_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT elements_screen_fkey
        FOREIGN KEY (screen_id, tenant_id)
        REFERENCES screens (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT elements_id_tenant_key UNIQUE (id, tenant_id),
    CONSTRAINT elements_screen_key_key UNIQUE (screen_id, element_key)
);

CREATE INDEX elements_screen_idx ON elements (screen_id);

CREATE TABLE nav_edges (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid    NOT NULL,
    memory_version_id uuid    NOT NULL,
    from_screen       uuid    NOT NULL,
    to_screen         uuid    NOT NULL,
    trigger_element   uuid    NOT NULL,
    preconditions     jsonb   NOT NULL DEFAULT '[]'::jsonb,
    confidence        numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT nav_edges_memory_version_fkey
        FOREIGN KEY (memory_version_id, tenant_id)
        REFERENCES memory_versions (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT nav_edges_from_screen_fkey
        FOREIGN KEY (from_screen, tenant_id)
        REFERENCES screens (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT nav_edges_to_screen_fkey
        FOREIGN KEY (to_screen, tenant_id)
        REFERENCES screens (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT nav_edges_trigger_element_fkey
        FOREIGN KEY (trigger_element, tenant_id)
        REFERENCES elements (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT nav_edges_preconditions_is_array CHECK (jsonb_typeof(preconditions) = 'array'),
    CONSTRAINT nav_edges_unique UNIQUE (memory_version_id, from_screen, to_screen, trigger_element)
);

CREATE INDEX nav_edges_from_screen_idx ON nav_edges (from_screen);
CREATE INDEX nav_edges_memory_version_idx ON nav_edges (memory_version_id);

CREATE TABLE aliases (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid        NOT NULL,
    memory_version_id uuid        NOT NULL,
    -- Normalised and already redacted. Vocabulary is per tenant even though structural
    -- learning may be shared, which is why `tenant_id` is part of the uniqueness below.
    phrase            text        NOT NULL CHECK (length(btrim(phrase)) > 0),
    element_id        uuid        NOT NULL,
    -- Null means the alias applies anywhere in the application rather than on one screen.
    state_fingerprint text CHECK (state_fingerprint ~ '^[0-9a-f]{64}$'),
    source            text        NOT NULL,
    hits              integer     NOT NULL DEFAULT 0 CHECK (hits >= 0),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT aliases_source_check
        CHECK (source IN ('indexed', 't2_writeback', 'manual')),
    CONSTRAINT aliases_memory_version_fkey
        FOREIGN KEY (memory_version_id, tenant_id)
        REFERENCES memory_versions (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT aliases_element_fkey
        FOREIGN KEY (element_id, tenant_id)
        REFERENCES elements (id, tenant_id) ON DELETE CASCADE
);

-- The T0 lookup, and the upsert target for the T2 write-back that makes the compounding loop
-- work: docs/BUILD-PLAN.md Phase 8 dedupes on `(memory_version_id, phrase)` and increments
-- `hits` on conflict. Because the composite FK above forces `tenant_id` to equal the memory
-- version's owner, uniqueness on the triple is exactly uniqueness on that pair — so this single
-- index is both the dedupe constraint and the tenant-scoped lookup path Phase 3 asks for.
CREATE UNIQUE INDEX aliases_tenant_version_phrase_key
    ON aliases (tenant_id, memory_version_id, phrase);

CREATE INDEX aliases_element_idx ON aliases (element_id);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Entity schemas — the per-application knowledge the test data engine is built on
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE entity_schemas (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid        NOT NULL,
    memory_version_id uuid        NOT NULL,
    entity_name       text        NOT NULL CHECK (length(btrim(entity_name)) > 0),
    observed_count    integer     NOT NULL DEFAULT 0 CHECK (observed_count >= 0),
    confidence        numeric     NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT entity_schemas_memory_version_fkey
        FOREIGN KEY (memory_version_id, tenant_id)
        REFERENCES memory_versions (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT entity_schemas_id_tenant_key UNIQUE (id, tenant_id),
    CONSTRAINT entity_schemas_version_name_key UNIQUE (memory_version_id, entity_name)
);

CREATE TABLE field_specs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid    NOT NULL,
    entity_schema_id    uuid    NOT NULL,
    name                text    NOT NULL CHECK (length(btrim(name)) > 0),
    type                text    NOT NULL,
    required            boolean NOT NULL,
    -- Non-null when the field is computed. The solver evaluates these last.
    derived_rule        jsonb,
    -- Learned vocabulary for `enum` fields, null for every other type — see the CHECK below.
    enum_values         jsonb,
    -- PII: shape, range and frequency only. Raw observed values are never persisted.
    distribution        jsonb,
    references_entity   text,
    value_constraints   jsonb   NOT NULL DEFAULT '{}'::jsonb,
    control_element_key text
        CHECK (control_element_key ~ '^[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*){2}$'),
    is_unique           boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT field_specs_type_check CHECK (type IN (
        'string', 'text', 'integer', 'number', 'currency', 'boolean',
        'date', 'datetime', 'enum', 'reference', 'group'
    )),
    CONSTRAINT field_specs_enum_values_check
        CHECK (enum_values IS NULL OR jsonb_typeof(enum_values) = 'array'),
    -- A reference field must name its target, and nothing else may.
    CONSTRAINT field_specs_references_entity_check
        CHECK ((type = 'reference') = (references_entity IS NOT NULL)),
    CONSTRAINT field_specs_entity_schema_fkey
        FOREIGN KEY (entity_schema_id, tenant_id)
        REFERENCES entity_schemas (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT field_specs_schema_name_key UNIQUE (entity_schema_id, name)
);

CREATE TABLE materializers (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid    NOT NULL,
    entity_schema_id       uuid    NOT NULL,
    kind                   text    NOT NULL,
    spec                   jsonb   NOT NULL,
    priority               integer NOT NULL CHECK (priority >= 0),
    -- Null means never verified. Such a materializer may not run ahead of the UI adapter:
    -- a stale replay silently tests nothing (docs/TEST-DATA-ENGINE.md § 4).
    verified_at            timestamptz,
    verification_ttl_hours integer NOT NULL DEFAULT 168 CHECK (verification_ttl_hours >= 1),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT materializers_kind_check CHECK (kind IN ('api', 'ui', 'fixture')),
    CONSTRAINT materializers_entity_schema_fkey
        FOREIGN KEY (entity_schema_id, tenant_id)
        REFERENCES entity_schemas (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT materializers_schema_kind_key UNIQUE (entity_schema_id, kind)
);

-- The fallback chain reads these in priority order for one entity.
CREATE INDEX materializers_schema_priority_idx ON materializers (entity_schema_id, priority);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Sessions
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE sessions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid        NOT NULL,
    application_id    uuid        NOT NULL,
    memory_version_id uuid        NOT NULL,
    user_id           uuid        NOT NULL,
    started_at        timestamptz NOT NULL DEFAULT now(),
    -- Non-null once closed. Sessions are immutable after that, enforced in the API.
    ended_at          timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sessions_ended_after_started CHECK (ended_at IS NULL OR ended_at >= started_at),
    CONSTRAINT sessions_application_fkey
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT sessions_memory_version_fkey
        FOREIGN KEY (memory_version_id, tenant_id)
        REFERENCES memory_versions (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT sessions_user_fkey
        FOREIGN KEY (user_id, tenant_id)
        REFERENCES users (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT sessions_id_tenant_key UNIQUE (id, tenant_id)
);

CREATE INDEX sessions_tenant_started_idx ON sessions (tenant_id, started_at DESC);
CREATE INDEX sessions_application_idx ON sessions (application_id, started_at DESC);

CREATE TABLE session_steps (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid        NOT NULL,
    session_id   uuid        NOT NULL,
    ordinal      integer     NOT NULL CHECK (ordinal >= 0),
    -- Already redacted. Raw audio is never persisted and neither is a raw transcript.
    utterance    text        NOT NULL,
    intent       jsonb       NOT NULL,
    resolution   jsonb       NOT NULL,
    -- Set null rather than cascading: a step must survive the element it acted on being
    -- removed by an approved drift report. The timeline is evidence, and evidence does not
    -- disappear because the application changed afterwards.
    element_id   uuid,
    tier         text,
    confidence   numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    action_class text,
    latency_ms   numeric     NOT NULL CHECK (latency_ms >= 0),
    outcome      text        NOT NULL,
    evidence     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT session_steps_tier_check CHECK (tier IS NULL OR tier IN ('T0', 'T1', 'T2')),
    CONSTRAINT session_steps_action_class_check
        CHECK (action_class IS NULL OR action_class IN ('R', 'C', 'A', 'S')),
    CONSTRAINT session_steps_outcome_check
        CHECK (outcome IN ('executed', 'staged', 'rolled_back', 'rejected', 'failed')),
    CONSTRAINT session_steps_evidence_is_array CHECK (jsonb_typeof(evidence) = 'array'),
    CONSTRAINT session_steps_session_fkey
        FOREIGN KEY (session_id, tenant_id)
        REFERENCES sessions (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT session_steps_element_fkey
        FOREIGN KEY (element_id, tenant_id)
        REFERENCES elements (id, tenant_id) ON DELETE SET NULL (element_id)
);

-- Step ingest is batched and idempotent on `(session_id, ordinal)` — docs/BUILD-PLAN.md
-- Phase 12. The unique index is both that idempotency key and the timeline read path.
CREATE UNIQUE INDEX session_steps_session_ordinal_key ON session_steps (session_id, ordinal);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Seeding
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE seed_ledger (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid        NOT NULL,
    session_id       uuid        NOT NULL,
    plan_id          uuid        NOT NULL,
    -- Plan-local node identifier, so a multi-entity graph reverts in reverse dependency order.
    node_id          text        NOT NULL CHECK (length(btrim(node_id)) > 0),
    -- Nullable and SET NULL on delete: the ledger records records that exist in the customer's
    -- application right now. It has to outlive the learned schema they were composed from, or a
    -- re-index would strand rows nobody can revert.
    entity_schema_id uuid,
    entity           text        NOT NULL CHECK (length(btrim(entity)) > 0),
    external_ref     text        NOT NULL CHECK (length(btrim(external_ref)) > 0),
    adapter_used     text        NOT NULL,
    payload          jsonb       NOT NULL,
    provenance       jsonb       NOT NULL,
    -- Never null. `{"kind":"none","reason":...}` is a real answer and must be shown in the
    -- preview *before* creating — docs/TEST-DATA-ENGINE.md § 5.
    inverse_op       jsonb       NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    reverted_at      timestamptz,

    CONSTRAINT seed_ledger_adapter_check CHECK (adapter_used IN ('api', 'ui', 'fixture')),
    CONSTRAINT seed_ledger_provenance_is_array CHECK (jsonb_typeof(provenance) = 'array'),
    CONSTRAINT seed_ledger_reverted_after_created
        CHECK (reverted_at IS NULL OR reverted_at >= created_at),
    CONSTRAINT seed_ledger_session_fkey
        FOREIGN KEY (session_id, tenant_id)
        REFERENCES sessions (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT seed_ledger_entity_schema_fkey
        FOREIGN KEY (entity_schema_id, tenant_id)
        REFERENCES entity_schemas (id, tenant_id) ON DELETE SET NULL (entity_schema_id),
    CONSTRAINT seed_ledger_plan_node_key UNIQUE (plan_id, node_id)
);

-- Revert-by-session, and the "what did this session create" panel. Named in Phase 3.
CREATE INDEX seed_ledger_session_idx ON seed_ledger (session_id, created_at);
-- Finding what is still outstanding in an environment, for a tenant-wide revert.
CREATE INDEX seed_ledger_tenant_outstanding_idx
    ON seed_ledger (tenant_id, created_at) WHERE reverted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Governance
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE drift_reports (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid        NOT NULL,
    memory_version_id        uuid        NOT NULL,
    screen_id                uuid        NOT NULL,
    route_pattern            text        NOT NULL CHECK (route_pattern ~ '^/'),
    state_fingerprint        text        NOT NULL CHECK (state_fingerprint ~ '^[0-9a-f]{64}$'),
    expected_structural_hash text        NOT NULL CHECK (expected_structural_hash ~ '^[0-9a-f]{64}$'),
    observed_structural_hash text        NOT NULL CHECK (observed_structural_hash ~ '^[0-9a-f]{64}$'),
    -- Null until the indexer has reconciled the changed region.
    diff                     jsonb,
    status                   text        NOT NULL DEFAULT 'open',
    detected_by              text        NOT NULL,
    alias_migration_rate     numeric CHECK (alias_migration_rate IS NULL
                                            OR alias_migration_rate BETWEEN 0 AND 1),
    -- Human approval is required before a memory version becomes active. Automatic self-healing
    -- is what destroyed trust in the previous generation of QA tools; there is no auto-approve
    -- path and none is to be added, even behind a flag (docs/BUILD-PLAN.md Phase 17).
    approved_by              uuid,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    resolved_at              timestamptz,

    CONSTRAINT drift_reports_status_check
        CHECK (status IN ('open', 'reconciling', 'diffed', 'approved', 'rejected')),
    CONSTRAINT drift_reports_detected_by_check
        CHECK (detected_by IN ('extension', 'indexer')),
    -- A report cannot be approved or rejected without a human on the record.
    CONSTRAINT drift_reports_decision_needs_approver
        CHECK (status NOT IN ('approved', 'rejected')
               OR (approved_by IS NOT NULL AND resolved_at IS NOT NULL)),
    CONSTRAINT drift_reports_memory_version_fkey
        FOREIGN KEY (memory_version_id, tenant_id)
        REFERENCES memory_versions (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT drift_reports_screen_fkey
        FOREIGN KEY (screen_id, tenant_id)
        REFERENCES screens (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT drift_reports_approved_by_fkey
        FOREIGN KEY (approved_by, tenant_id)
        REFERENCES users (id, tenant_id) ON DELETE SET NULL (approved_by)
);

-- The console's pending-review queue, per application version.
CREATE INDEX drift_reports_open_idx
    ON drift_reports (tenant_id, memory_version_id, created_at)
    WHERE status IN ('open', 'reconciling', 'diffed');

CREATE TABLE audit_log (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- Free text rather than a user reference: an actor may be a service, and the record has to
    -- survive the account being deleted. Every memory mutation, seed, revert and approval
    -- lands here (docs/ARCHITECTURE.md § 8).
    actor      text        NOT NULL CHECK (length(btrim(actor)) > 0),
    action     text        NOT NULL CHECK (length(btrim(action)) > 0),
    target     text        NOT NULL CHECK (length(btrim(target)) > 0),
    metadata   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_created_idx ON audit_log (tenant_id, created_at DESC);
