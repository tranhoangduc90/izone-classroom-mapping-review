BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE IF NOT EXISTS learning.shared_library_archive_grant (
  reviewer_email text NOT NULL CHECK (reviewer_email = lower(trim(reviewer_email))),
  course_code text NOT NULL CHECK (course_code IN ('34','45','56','67')),
  grant_reference text NOT NULL CHECK (length(trim(grant_reference)) > 0),
  granted_by_email text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (reviewer_email, course_code)
);
GRANT SELECT ON learning.shared_library_archive_grant TO learning_api;

ALTER TABLE learning.form_draft
  ADD COLUMN IF NOT EXISTS copied_shared_draft_id uuid REFERENCES learning.form_draft(id),
  ADD COLUMN IF NOT EXISTS copied_shared_draft_revision integer,
  ADD COLUMN IF NOT EXISTS copied_shared_draft_hash text,
  ADD COLUMN IF NOT EXISTS copied_shared_draft_title text;
COMMIT;
