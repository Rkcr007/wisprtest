-- The indexed delete flow for each learned entity: how a seeded record is removed again.
--
-- docs/TEST-DATA-ENGINE.md § 5 makes reversibility the adoption gate — "testers will not adopt a
-- tool that quietly fills staging with garbage" — and requires the preview to say, *before* the
-- record is created, whether it can be removed. That is only answerable up front if the delete
-- flow is discovered when the application is indexed rather than when the revert is attempted.
--
-- Null is a real value and the common one: plenty of applications have no delete control at all,
-- or name it in words the generic search does not recognise. Both cases produce
-- `{"kind":"none","reason":…}` in the ledger and a preview that says so, which is the honest
-- outcome and a better one than a revert button that fails when pressed.
--
-- Why here rather than in `materializers`: a materializer is a way to *create* a record and
-- carries its own spec shape; the delete flow is one element key belonging to the entity, needed
-- by whichever adapter ends up creating it. Modelling it as a materializer would mean inventing a
-- fourth kind that creates nothing.

ALTER TABLE entity_schemas
    ADD COLUMN delete_flow_element_key text
        CHECK (delete_flow_element_key ~ '^[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*){2}$');

COMMENT ON COLUMN entity_schemas.delete_flow_element_key IS
    'Element key of the indexed control that removes one record of this entity, or null when '
    'none was found. Null becomes InverseOperation {kind:"none"} and is shown in the seed '
    'preview before anything is created.';
