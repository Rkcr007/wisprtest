-- Persist the application's auth profile, so a background browser can log in.
--
-- docs/TEST-DATA-ENGINE.md § 1 lists auth profiles as per-application knowledge, alongside the
-- schemas and the materializers. Until now they have only ever existed on a `CrawlJob`: Phase 5
-- takes the profile on the crawl request and hands it straight to the worker, so it lives exactly
-- as long as the job does. That works for crawling, where a human is starting the run and can say
-- how to log in.
--
-- It does not work for the UI materializer. Phase 15's adapter drives the real create form in a
-- background context, minutes or hours after anyone typed anything, and an adapter that cannot
-- authenticate can only seed applications that need no authentication — which is to say, almost
-- none of them. So the profile becomes a property of the application.
--
-- ## This does not store a credential
--
-- `AuthProfile` in `packages/protocol` cannot carry one. A form profile holds a `SecretRef` — a
-- pointer into the tenant's configured secret store — and a storage-state profile holds a
-- reference to a blob the tester captured. Both are resolved at the moment of use by
-- `apps/indexer/src/crawl/secrets.ts` and never persisted here. CLAUDE.md § "PII rule" and
-- ARCHITECTURE § 8 both turn on that distinction, and it is why this column can be a plain jsonb
-- rather than something encrypted at rest.
--
-- ## Default rather than NOT NULL with a backfill
--
-- Existing rows get `{"kind":"none"}`, which is the honest answer for an application nobody has
-- configured: the crawl and the adapter both proceed unauthenticated and fail visibly against a
-- login wall, rather than silently indexing or seeding the wrong thing.
--
-- The crawl path is deliberately left alone. It still takes the profile per job, because the
-- record of what a crawl was permitted to do should be the record that was executed (see
-- `apps/indexer/src/config.ts`). Making the job's profile default to this column is a change to
-- Phase 5's route and belongs with whoever owns that next.

ALTER TABLE applications
    ADD COLUMN auth_profile jsonb NOT NULL DEFAULT '{"kind": "none"}'::jsonb;

-- A profile is an object with a `kind`. The value set itself is owned by `packages/protocol` and
-- validated there — this constraint only stops the column holding an array, a bare string or a
-- shape with no discriminant at all, which no amount of downstream parsing could recover from.
ALTER TABLE applications
    ADD CONSTRAINT applications_auth_profile_shape CHECK (
        jsonb_typeof(auth_profile) = 'object' AND auth_profile ? 'kind'
    );

COMMENT ON COLUMN applications.auth_profile IS
    'How a background browser authenticates against this application. Holds secret references '
    'only — never a credential. Validated against protocol.AuthProfile on read.';
