-- Class read access scoped to an ERP course. Assignment and editing still use
-- the teacher's class assignments or the separate Progress Log admin grant.
CREATE TABLE IF NOT EXISTS learning.progress_log_course_viewer (
  reviewer_email text NOT NULL REFERENCES mapping.reviewer_account(email),
  course_id bigint NOT NULL CHECK (course_id > 0),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reviewer_email, course_id)
);
GRANT SELECT ON learning.progress_log_course_viewer TO learning_api;
