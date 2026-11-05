BEGIN;
CREATE TABLE IF NOT EXISTS learning.form_publication_lock(source_key text PRIMARY KEY);
GRANT SELECT,INSERT,UPDATE(source_key) ON learning.form_publication_lock TO learning_api;
-- Tombstones only: never delete drafts, immutable versions, deliveries or student work.
CREATE TABLE IF NOT EXISTS learning.form_catalog_archive (
 sharing_scope text NOT NULL CHECK (sharing_scope IN ('personal','izone')),
 source_draft_id uuid NOT NULL,
 owner_email text NOT NULL,
 operation_id uuid NOT NULL,
 archived_by_email text NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(sharing_scope,source_draft_id,owner_email)
);
GRANT SELECT,INSERT ON learning.form_catalog_archive TO learning_api;
CREATE TABLE IF NOT EXISTS learning.frontend_release_state (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 version text NOT NULL CHECK(version ~ '^[a-f0-9]{16}$'),
 verified_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE(version,verified_at) ON learning.frontend_release_state TO learning_api;
COMMIT;
