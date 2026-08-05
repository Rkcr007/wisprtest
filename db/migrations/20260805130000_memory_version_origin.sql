-- What built a memory version, so two things that both leave one `building` cannot collide.
--
-- ## The collision this prevents
--
-- `openMemoryVersion` in the indexer resumes any `building` version for an application. That is
-- Phase 5's resumability and it is correct for crawling: a job that died mid-run must pick up
-- where it stopped rather than start a second version and abandon the first.
--
-- Phase 17 introduces a second producer of `building` versions. A drift reconcile clones the
-- active version, applies what it observed, and leaves the clone `building` for a human to
-- activate (see 20260805120000_drift_candidate_and_route.sql). Without this column those two are
-- indistinguishable, and the failure is quiet in both directions:
--
--   * A crawl started after a reconcile resumes the *drift candidate* and writes its screens into
--     it. A reviewer then approves a version that is half reconcile and half crawl, believing it
--     to be the small reviewed change the diff described.
--   * A reconcile running while a crawl is in flight would take over the crawl's version, and the
--     crawl would finish by activating something a reconcile had been editing underneath it.
--
-- Neither produces an error. Both produce a memory version nobody intended and a human approval
-- that means something other than what it said.
--
-- ## Why a column rather than a convention
--
-- The alternative is for each producer to look at timestamps, or for the reconcile to avoid
-- `openMemoryVersion` and insert directly — which fixes one direction and leaves the other, since
-- the crawl would still resume the candidate. The property wanted is that the two *kinds* of
-- in-progress version are distinguishable at all, and only the row can carry that.
--
-- Existing rows are crawls, because until this migration a crawl was the only thing that made
-- one. NOT NULL with that default rather than nullable: "unknown origin" is not a state anything
-- should have to handle, and leaving it representable means somebody eventually handles it wrong.

ALTER TABLE memory_versions
    ADD COLUMN origin text NOT NULL DEFAULT 'crawl'
        CHECK (origin IN ('crawl', 'reconcile'));

-- The exact lookup `openMemoryVersion` performs: the newest resumable version for an application.
-- Partial, because a resumable version is the only thing this query ever asks about, and the
-- table is dominated by superseded ones.
CREATE INDEX memory_versions_resumable_idx
    ON memory_versions (application_id, version DESC)
    WHERE status = 'building';

COMMENT ON COLUMN memory_versions.origin IS
    'What produced this version: a crawl, or a drift reconcile. Read by openMemoryVersion so a '
    'crawl only ever resumes another crawl — a reconcile''s candidate is a reviewed proposal and '
    'must not be written into by anything else before a human sees it.';
