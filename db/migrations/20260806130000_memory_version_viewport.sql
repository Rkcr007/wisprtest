-- The viewport a memory version's fingerprints were measured at.
--
-- ## Why a fingerprint is not self-describing
--
-- `ElementFingerprint.bbox` is viewport-normalised (packages/fingerprint/src/geometry.ts): the
-- stored numbers are fractions of the width and height the page was rendered at. That makes a
-- fingerprint portable between screen sizes, but only if whoever compares against it knows which
-- size it was normalised to. The normalised value alone cannot say.
--
-- `CrawlBounds.viewport` is where that size comes from, and it is required with no default —
-- anything from 320x240 to 7680x4320 (packages/protocol/src/indexing.ts, `CrawlViewport`). It
-- arrives per crawl request and was, until now, persisted nowhere. The moment the crawl ended,
-- the one fact needed to interpret its geometry was gone.
--
-- ## What that cost
--
-- Anything revisiting an indexed page later has had to guess. Both the seed adapters and the
-- Phase 17 drift reconcile open at a fixed 1440x900 (`SEED_VIEWPORT`), so an application indexed
-- at any other size has every stored bbox compared against a differently-normalised live one.
-- The bbox signal then scores low for every element at once — not because anything moved, but
-- because the two sides measured against different rulers.
--
-- It is a quiet failure rather than a loud one. bbox carries 0.05 of the weight
-- (docs/ARCHITECTURE.md § 2), so nothing breaks outright; matches simply sit closer to their
-- thresholds than they should, and the elements with the least other evidence — no test id, no
-- accessible name, identified largely by role and position — are the ones pushed under.
--
-- ## Nullable, because older versions genuinely do not know
--
-- Unlike `memory_versions.origin`, there is no correct backfill. A version crawled before this
-- migration was measured at a size nobody recorded, and inventing 1440x900 for it would assert
-- something false about every fingerprint it holds. Null means "not recorded", readers fall back
-- to their previous fixed viewport, and the fallback disappears as versions are re-crawled.
--
-- Both columns move together: a width without a height describes nothing.

ALTER TABLE memory_versions
    ADD COLUMN viewport_width  integer,
    ADD COLUMN viewport_height integer,
    ADD CONSTRAINT memory_versions_viewport_paired
        CHECK ((viewport_width IS NULL) = (viewport_height IS NULL)),
    -- The same bounds `CrawlViewport` enforces at the contract edge. Repeated here because this
    -- column is also written by a clone, which copies rather than re-validating.
    ADD CONSTRAINT memory_versions_viewport_range
        CHECK (viewport_width IS NULL
               OR (viewport_width BETWEEN 320 AND 7680 AND viewport_height BETWEEN 240 AND 4320));

COMMENT ON COLUMN memory_versions.viewport_width IS
    'Width of the viewport this version''s fingerprints were normalised against, from '
    'CrawlBounds.viewport. Null for versions crawled before it was recorded; readers fall back to '
    'a fixed viewport and accept a degraded bbox signal.';

COMMENT ON COLUMN memory_versions.viewport_height IS
    'Height of the viewport this version''s fingerprints were normalised against. Null exactly '
    'when viewport_width is.';
