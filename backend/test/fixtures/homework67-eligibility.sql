-- Fixture đồng bộ với mapping-db 202611110819, dùng riêng trong Speaking tests.
ALTER TABLE mapping.classroom_course_mapping ADD COLUMN IF NOT EXISTS classroom_course_id text;
ALTER TABLE mapping.student_mapping_review ADD COLUMN IF NOT EXISTS classroom_course_id text;
UPDATE mapping.classroom_course_mapping
   SET classroom_course_id = coalesce(classroom_course_id, 'course-' || erp_course_class_id);
UPDATE mapping.student_mapping_review m
   SET classroom_course_id = c.classroom_course_id
  FROM mapping.classroom_course_mapping c
 WHERE m.erp_course_class_id = c.erp_course_class_id;
CREATE TABLE mapping.homework67_student_access (
  erp_course_class_id bigint NOT NULL,
  student_ref uuid NOT NULL,
  classroom_course_id text NOT NULL CHECK (classroom_course_id <> ''),
  google_user_id text NOT NULL CHECK (google_user_id <> ''),
  granted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  granted_by text NOT NULL DEFAULT session_user,
  revoked_at timestamptz,
  PRIMARY KEY (erp_course_class_id, student_ref),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

REVOKE ALL ON mapping.homework67_student_access FROM PUBLIC;

CREATE VIEW mapping.homework67_eligible_member WITH (security_barrier=true) AS
SELECT e.erp_course_class_id, e.erp_student_contact_id
FROM mapping.erp_class_membership_snapshot e
WHERE e.source_state = 'active'
  AND (
    lower(trim(coalesce(e.registration_status, ''))) NOT IN ('dropped', 'on_hold')
    OR (
      lower(trim(coalesce(e.registration_status, ''))) = 'dropped'
      AND EXISTS (
        SELECT 1
        FROM mapping.homework67_student_access grant_row
        JOIN mapping.student_mapping_review m
          ON m.public_id = grant_row.student_ref
         AND m.erp_course_class_id = grant_row.erp_course_class_id
         AND m.classroom_course_id = grant_row.classroom_course_id
         AND m.classroom_user_id = grant_row.google_user_id
         AND m.status = 'approved'
        JOIN mapping.classroom_course_mapping c
          ON c.erp_course_class_id = m.erp_course_class_id
         AND c.classroom_course_id = m.classroom_course_id
         AND c.status = 'approved'
        WHERE grant_row.revoked_at IS NULL
          AND m.erp_course_class_id = e.erp_course_class_id
          AND m.erp_student_contact_id = e.erp_student_contact_id
      )
    )
  );
