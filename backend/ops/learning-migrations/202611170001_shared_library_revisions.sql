BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
CREATE TABLE IF NOT EXISTS learning.form_shared_library_item (
  id uuid PRIMARY KEY REFERENCES learning.form_library_entry(id),
  current_entry_id uuid NOT NULL UNIQUE REFERENCES learning.form_library_entry(id),
  course_code text NOT NULL,
  archived_at timestamptz,
  archived_by_email text,
  archive_operation_id uuid
);
CREATE TABLE IF NOT EXISTS learning.form_shared_library_revision (
  draft_id uuid PRIMARY KEY REFERENCES learning.form_draft(id),
  item_id uuid NOT NULL REFERENCES learning.form_shared_library_item(id),
  base_entry_id uuid NOT NULL REFERENCES learning.form_library_entry(id),
  published_entry_id uuid UNIQUE REFERENCES learning.form_library_entry(id)
);
CREATE INDEX IF NOT EXISTS form_shared_library_revision_item_base
  ON learning.form_shared_library_revision(item_id,base_entry_id);
GRANT SELECT,INSERT,UPDATE ON learning.form_shared_library_item,learning.form_shared_library_revision TO learning_api;
COMMIT;
