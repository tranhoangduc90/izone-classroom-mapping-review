-- Link a new delivery to the exact Portal lesson. Existing assignments and plans need no backfill.
CREATE TABLE IF NOT EXISTS learning.form_assignment_portal_target (
  assignment_id uuid PRIMARY KEY REFERENCES learning.form_assignment(id),
  portal_session_id bigint NOT NULL CHECK (portal_session_id > 0),
  starts_at text NOT NULL CHECK (starts_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'),
  attendance_fingerprint text NOT NULL
);
GRANT SELECT, INSERT ON learning.form_assignment_portal_target TO learning_api;
