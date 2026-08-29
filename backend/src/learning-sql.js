// Mọi truy vấn dùng placeholder PostgreSQL; không ghép input học viên/giảng viên vào chuỗi SQL.

export const fetchPublicLearningAssignmentSql = `SELECT
  assignment.id::text AS assignment_id,
  assignment.public_token::text AS public_token,
  assignment.organization_key,
  assignment.course_code,
  assignment.erp_course_class_id::text AS class_id,
  assignment.class_name_snapshot AS class_name,
  assignment.session_number,
  assignment.title,
  assignment.opens_at,
  assignment.closes_at,
  assignment.status,
  version.id::text AS form_version_id,
  version.definition_hash,
  version.public_definition,
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'studentRef', roster.student_ref::text,
        'name', roster.student_name_snapshot,
        'discriminator', roster.display_discriminator
      ) ORDER BY roster.student_name_snapshot, roster.student_ref
    )
    FROM learning.form_assignment_roster AS roster
    WHERE roster.assignment_id = assignment.id
  ), '[]'::jsonb) AS roster
FROM learning.form_assignment AS assignment
JOIN learning.form_version AS version ON version.id = assignment.form_version_id
WHERE assignment.public_token = $1::uuid
  AND assignment.status = 'published'
  AND version.status = 'published'
  AND (assignment.opens_at IS NULL OR assignment.opens_at <= now())
  AND (assignment.closes_at IS NULL OR assignment.closes_at > now());`;

export const fetchAssignmentStudentSql = `SELECT
  assignment.id::text AS assignment_id,
  assignment.form_version_id::text AS form_version_id,
  version.definition_hash,
  roster.student_ref::text AS student_ref,
  roster.student_name_snapshot AS student_name,
  roster.display_discriminator,
  assignment.erp_course_class_id::text AS class_id,
  assignment.class_name_snapshot AS class_name,
  assignment.session_number,
  assignment.organization_key,
  assignment.course_code
FROM learning.form_assignment AS assignment
JOIN learning.form_version AS version ON version.id = assignment.form_version_id
JOIN learning.form_assignment_roster AS roster
  ON roster.assignment_id = assignment.id
  AND roster.student_ref = $2::uuid
WHERE assignment.public_token = $1::uuid
  AND assignment.status = 'published'
  AND version.status = 'published'
  AND (assignment.opens_at IS NULL OR assignment.opens_at <= now())
  AND (assignment.closes_at IS NULL OR assignment.closes_at > now());`;

export const findActiveLearningAttemptSql = `SELECT
  id::text AS attempt_id,
  attempt_token::text AS attempt_token,
  assignment_id::text AS assignment_id,
  form_version_id::text AS form_version_id,
  definition_hash,
  student_ref::text AS student_ref,
  draft,
  draft_revision,
  status
FROM learning.attempt
WHERE assignment_id = $1::uuid
  AND student_ref = $2::uuid
  AND status = 'active'
ORDER BY created_at DESC
LIMIT 1
FOR UPDATE;`;

export const insertLearningAttemptSql = `INSERT INTO learning.attempt (
  assignment_id,
  form_version_id,
  definition_hash,
  student_ref,
  client_idempotency_key,
  identity_confirmation
) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, 'self_confirmed')
ON CONFLICT (assignment_id, student_ref) WHERE status = 'active' DO UPDATE SET
  updated_at = learning.attempt.updated_at
RETURNING
  id::text AS attempt_id,
  attempt_token::text AS attempt_token,
  assignment_id::text AS assignment_id,
  form_version_id::text AS form_version_id,
  definition_hash,
  student_ref::text AS student_ref,
  draft,
  draft_revision,
  status;`;

export const fetchLearningAttemptContextSql = `SELECT
  attempt.id::text AS attempt_id,
  attempt.attempt_token::text AS attempt_token,
  attempt.assignment_id::text AS assignment_id,
  attempt.form_version_id::text AS form_version_id,
  attempt.definition_hash,
  attempt.student_ref::text AS student_ref,
  attempt.status AS attempt_status,
  attempt.draft,
  attempt.draft_hash,
  attempt.draft_revision,
  assignment.organization_key,
  assignment.course_code,
  assignment.erp_course_class_id::text AS class_id,
  assignment.class_name_snapshot AS class_name,
  assignment.session_number,
  assignment.title AS assignment_title,
  assignment.status AS assignment_status,
  assignment.closes_at,
  roster.student_name_snapshot AS student_name,
  version.public_definition,
  grading.grader_version,
  grading.private_definition
FROM learning.attempt AS attempt
JOIN learning.form_assignment AS assignment ON assignment.id = attempt.assignment_id
JOIN learning.form_assignment_roster AS roster
  ON roster.assignment_id = attempt.assignment_id
  AND roster.student_ref = attempt.student_ref
JOIN learning.form_version AS version
  ON version.id = attempt.form_version_id
  AND version.definition_hash = attempt.definition_hash
JOIN learning.form_grading_key AS grading ON grading.form_version_id = version.id
WHERE attempt.attempt_token = $1::uuid
FOR UPDATE OF attempt;`;

export const saveLearningDraftSql = `UPDATE learning.attempt
SET
  draft = $3::jsonb,
  draft_hash = $4,
  draft_revision = $2,
  draft_updated_at = now(),
  updated_at = now()
WHERE attempt_token = $1::uuid
  AND status = 'active'
  AND definition_hash = $5
  AND (
    draft_revision < $2
    OR (draft_revision = $2 AND draft_hash = $4)
  )
RETURNING draft_revision, draft_hash, draft_updated_at;`;

export const findLearningSubmissionSql = `SELECT
  submission.id::text AS submission_id,
  submission.attempt_id::text AS attempt_id,
  submission.student_ref::text AS student_ref,
  submission.response_hash,
  submission.completeness,
  submission.grading_status,
  submission.receipt,
  submission.submitted_at,
  run.id::text AS grading_run_id,
  run.result_json,
  version.public_definition
FROM learning.submission AS submission
JOIN learning.attempt AS attempt ON attempt.id = submission.attempt_id
JOIN learning.form_version AS version ON version.id = submission.form_version_id
LEFT JOIN learning.grading_run AS run ON run.submission_id = submission.id
WHERE attempt.attempt_token = $1::uuid;`;

export const insertLearningSubmissionSql = `INSERT INTO learning.submission (
  id,
  attempt_id,
  assignment_id,
  form_version_id,
  student_ref,
  source_revision,
  response_payload,
  response_hash,
  completeness,
  grading_status,
  receipt,
  submitted_at
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1,
  $6::jsonb, $7, $8, $9, $10::jsonb, $11::timestamptz
)
RETURNING id::text AS submission_id, submitted_at;`;

export const insertLearningResponseItemSql = `INSERT INTO learning.response_item (
  submission_id,
  item_version_id,
  item_family_id,
  position,
  interaction_type,
  pedagogical_type_code,
  skill_codes,
  response_value,
  answer_state
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9);`;

export const insertLearningGradingRunSql = `INSERT INTO learning.grading_run (
  submission_id,
  grader_version,
  operation_key,
  idempotency_key,
  status,
  result_json,
  completed_at
) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, CASE WHEN $5 = 'complete' THEN now() ELSE NULL END)
RETURNING id::text AS grading_run_id;`;

export const insertLearningGradingResultItemSql = `INSERT INTO learning.grading_result_item (
  grading_run_id,
  item_version_id,
  raw_answer,
  normalized_answer,
  expected_answer,
  answer_state,
  verdict,
  score_earned,
  max_score
) VALUES ($1::uuid, $2::uuid, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9);`;

export const fetchAttendanceForUpdateSql = `SELECT status
FROM learning.attendance_record
WHERE assignment_id = $1::uuid
  AND student_ref = $2::uuid
FOR UPDATE;`;

export const upsertLearningAttendanceSql = `INSERT INTO learning.attendance_record (
  assignment_id,
  student_ref,
  status,
  source_submission_id,
  current_reason,
  decided_at,
  updated_at
) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, now(), now())
ON CONFLICT (assignment_id, student_ref) DO UPDATE SET
  status = EXCLUDED.status,
  source_submission_id = EXCLUDED.source_submission_id,
  current_reason = EXCLUDED.current_reason,
  decided_by_email = NULL,
  decided_at = now(),
  updated_at = now();`;

export const insertLearningAttendanceEventSql = `INSERT INTO learning.attendance_event (
  assignment_id,
  student_ref,
  previous_status,
  new_status,
  source_submission_id,
  reason,
  actor_type,
  operation_key
) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, 'system', $7);`;

export const insertLearningEvidenceSql = `INSERT INTO learning.evidence_event (
  id,
  source_system,
  source_record_id,
  source_revision,
  entity_key,
  unit_key,
  operation_key,
  idempotency_key,
  organization_key,
  course_code,
  erp_course_class_id,
  session_number,
  student_ref,
  form_version_id,
  assignment_id,
  submission_id,
  visibility,
  payload,
  content_hash,
  renderer_version,
  markdown,
  occurred_at,
  ingested_at
) VALUES (
  $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint, $12,
  $13::uuid, $14::uuid, $15::uuid, $16::uuid, $17, $18::jsonb, $19, $20, $21,
  $22::timestamptz, $23::timestamptz
);`;

export const insertLearningOutboxSql = `INSERT INTO learning.outbox_job (
  job_type,
  entity_key,
  unit_key,
  operation_key,
  idempotency_key,
  payload
) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
ON CONFLICT (idempotency_key) DO NOTHING;`;

export const completeLearningAttemptSql = `UPDATE learning.attempt
SET status = 'submitted', submitted_at = $2::timestamptz, updated_at = now()
WHERE id = $1::uuid
  AND status = 'active';`;

export const listLearningTeacherOptionsSql = `WITH allowed_classes AS (
  SELECT
    course.erp_course_class_id::text AS class_id,
    course.erp_class_name_snapshot AS class_name
  FROM mapping.classroom_course_mapping AS course
  WHERE $2::boolean
    OR EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_access AS access
      WHERE access.reviewer_email = $1
        AND access.erp_course_class_id = course.erp_course_class_id
    )
),
assignments AS (
  SELECT
    assignment.id::text AS assignment_id,
    assignment.public_token::text AS public_token,
    assignment.erp_course_class_id::text AS class_id,
    assignment.class_name_snapshot AS class_name,
    assignment.session_number,
    assignment.title,
    assignment.status,
    assignment.created_at
  FROM learning.form_assignment AS assignment
  JOIN allowed_classes ON allowed_classes.class_id = assignment.erp_course_class_id::text
)
SELECT jsonb_build_object(
  'classes', COALESCE((SELECT jsonb_agg(to_jsonb(allowed_classes) ORDER BY class_name) FROM allowed_classes), '[]'::jsonb),
  'assignments', COALESCE((SELECT jsonb_agg(to_jsonb(assignments) ORDER BY created_at DESC) FROM assignments), '[]'::jsonb)
) AS response;`;

export const listLearningQuestionLibrarySql = `SELECT
  id::text AS id,
  code,
  title,
  prompt,
  interaction_type,
  pedagogical_type_code,
  layout_type,
  grader_type,
  default_config
FROM learning.question_library
WHERE status = 'active'
ORDER BY code;`;

export const authorizeLearningClassSql = `SELECT
  course.erp_course_class_id::text AS class_id,
  course.erp_class_name_snapshot AS class_name
FROM mapping.classroom_course_mapping AS course
WHERE course.erp_course_class_id = $3::bigint
  AND (
    $2::boolean
    OR EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_access AS access
      WHERE access.reviewer_email = $1
        AND access.erp_course_class_id = course.erp_course_class_id
    )
  );`;

export const fetchLearningLibraryItemsSql = `WITH requested AS (
  SELECT item_id, ordinality
  FROM unnest($1::uuid[]) WITH ORDINALITY AS input(item_id, ordinality)
)
SELECT
  library.id::text AS id,
  library.code,
  library.title,
  library.prompt,
  library.interaction_type,
  library.pedagogical_type_code,
  library.layout_type,
  library.grader_type,
  library.default_config,
  requested.ordinality::int AS ordinality
FROM requested
JOIN learning.question_library AS library ON library.id = requested.item_id
WHERE library.status = 'active'
ORDER BY requested.ordinality;`;

export const fetchLearningRosterForClassSql = `WITH active_students AS (
  SELECT DISTINCT ON (review.erp_student_contact_id)
    review.public_id AS student_ref,
    review.erp_student_contact_id,
    review.erp_student_name_snapshot AS student_name
  FROM mapping.student_mapping_review AS review
  WHERE review.erp_course_class_id = $1::bigint
    AND review.status <> 'superseded'
  ORDER BY review.erp_student_contact_id, review.updated_at DESC NULLS LAST, review.id DESC
),
numbered AS (
  SELECT
    active_students.*,
    count(*) OVER (PARTITION BY lower(trim(student_name))) AS same_name_count,
    row_number() OVER (PARTITION BY lower(trim(student_name)) ORDER BY student_ref) AS same_name_number
  FROM active_students
)
SELECT
  student_ref::text AS student_ref,
  erp_student_contact_id::text AS student_id,
  student_name,
  CASE
    WHEN same_name_count > 1 THEN 'Học viên ' || same_name_number::text
    ELSE ''
  END AS display_discriminator
FROM numbered
ORDER BY student_name, student_ref;`;

export const insertLearningFormTemplateSql = `INSERT INTO learning.form_template (
  title, kind, created_by_email
) VALUES ($1, 'reflection', $2)
RETURNING id::text AS template_id;`;

export const insertLearningFormVersionSql = `INSERT INTO learning.form_version (
  id,
  template_id,
  version,
  schema_version,
  public_definition,
  definition_hash,
  status,
  created_by_email,
  approved_by_email,
  published_at
) VALUES ($1::uuid, $2::uuid, 1, 'FormDefinitionV1', $3::jsonb, $4, 'published', $5, $5, now());`;

export const insertLearningFormGradingKeySql = `INSERT INTO learning.form_grading_key (
  form_version_id,
  schema_version,
  grader_version,
  private_definition,
  content_hash
) VALUES ($1::uuid, 'FormGradingKeyV1', 1, $2::jsonb, $3);`;

export const insertLearningAssignmentSql = `INSERT INTO learning.form_assignment (
  form_version_id,
  course_code,
  erp_course_class_id,
  class_name_snapshot,
  session_number,
  title,
  status,
  opens_at,
  closes_at,
  created_by_email
) VALUES ($1::uuid, $2, $3::bigint, $4, $5, $6, 'published', $7::timestamptz, $8::timestamptz, $9)
RETURNING id::text AS assignment_id, public_token::text AS public_token;`;

export const insertLearningAssignmentRosterSql = `INSERT INTO learning.form_assignment_roster (
  assignment_id,
  student_ref,
  erp_student_contact_id,
  student_name_snapshot,
  display_discriminator
) VALUES ($1::uuid, $2::uuid, $3::bigint, $4, $5);`;

export const fetchLearningTeacherDashboardSql = `SELECT
  assignment.id::text AS assignment_id,
  assignment.title,
  assignment.session_number,
  assignment.class_name_snapshot AS class_name,
  assignment.public_token::text AS public_token,
  assignment.status,
  COALESCE(jsonb_agg(
    jsonb_build_object(
      'studentRef', status.student_ref::text,
      'name', status.student_name_snapshot,
      'discriminator', status.display_discriminator,
      'attemptStatus', status.attempt_status,
      'submissionId', status.submission_id::text,
      'completeness', status.completeness,
      'gradingStatus', status.grading_status,
      'submittedAt', status.submitted_at,
      'attendanceStatus', status.attendance_status,
      'attendanceReason', status.attendance_reason,
      'decidedBy', status.decided_by_email,
      'evidenceCount', COALESCE(evidence.evidence_count, 0),
      'evidenceSources', COALESCE(evidence.source_systems, '[]'::jsonb),
      'latestReport', CASE WHEN report.id IS NULL THEN NULL ELSE jsonb_build_object(
        'reportId', report.id::text,
        'status', report.status,
        'fromSessionNumber', report.from_session_number,
        'toSessionNumber', report.to_session_number,
        'systemOutput', report.system_output,
        'systemMarkdown', report.system_markdown,
        'humanNote', report.note_text
      ) END
    ) ORDER BY status.student_name_snapshot, status.student_ref
  ) FILTER (WHERE status.student_ref IS NOT NULL), '[]'::jsonb) AS students
FROM learning.form_assignment AS assignment
LEFT JOIN learning.assignment_student_status AS status ON status.assignment_id = assignment.id
LEFT JOIN LATERAL (
  SELECT
    count(*)::integer AS evidence_count,
    COALESCE(jsonb_agg(DISTINCT event.source_system), '[]'::jsonb) AS source_systems
  FROM learning.evidence_event AS event
  WHERE event.student_ref = status.student_ref
    AND event.erp_course_class_id = assignment.erp_course_class_id
    AND event.visibility IN ('analysis_allowed', 'student_visible')
) AS evidence ON true
LEFT JOIN LATERAL (
  SELECT periodic.*, note.note_text
  FROM learning.periodic_report AS periodic
  LEFT JOIN learning.teacher_human_note AS note ON note.report_id = periodic.id
  WHERE periodic.student_ref = status.student_ref
    AND periodic.erp_course_class_id = assignment.erp_course_class_id
    AND periodic.status IN ('ready_for_review', 'approved', 'published')
  ORDER BY periodic.updated_at DESC, periodic.id DESC
  LIMIT 1
) AS report ON true
WHERE assignment.id = $1::uuid
  AND (
    $3::boolean
    OR EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_access AS access
      WHERE access.reviewer_email = $2
        AND access.erp_course_class_id = assignment.erp_course_class_id
    )
  )
GROUP BY assignment.id;`;

export const overrideLearningAttendanceSql = `WITH target AS (
  SELECT assignment.id, roster.student_ref
  FROM learning.form_assignment AS assignment
  JOIN learning.form_assignment_roster AS roster
    ON roster.assignment_id = assignment.id
    AND roster.student_ref = $2::uuid
  WHERE assignment.id = $1::uuid
    AND (
      $6::boolean
      OR EXISTS (
        SELECT 1
        FROM mapping.reviewer_class_access AS access
        WHERE access.reviewer_email = $5
          AND access.erp_course_class_id = assignment.erp_course_class_id
      )
    )
),
previous AS (
  SELECT status
  FROM learning.attendance_record
  WHERE assignment_id = $1::uuid AND student_ref = $2::uuid
),
updated AS (
  INSERT INTO learning.attendance_record (
    assignment_id, student_ref, status, current_reason, decided_by_email, decided_at, updated_at
  )
  SELECT id, student_ref, $3, $4, $5, now(), now()
  FROM target
  ON CONFLICT (assignment_id, student_ref) DO UPDATE SET
    status = EXCLUDED.status,
    current_reason = EXCLUDED.current_reason,
    decided_by_email = EXCLUDED.decided_by_email,
    decided_at = now(),
    updated_at = now()
  RETURNING assignment_id, student_ref, status, current_reason, decided_by_email, decided_at
),
event AS (
  INSERT INTO learning.attendance_event (
    assignment_id, student_ref, previous_status, new_status, reason,
    actor_type, actor_email, operation_key
  )
  SELECT
    updated.assignment_id,
    updated.student_ref,
    (SELECT status FROM previous LIMIT 1),
    updated.status,
    updated.current_reason,
    'teacher',
    updated.decided_by_email,
    $7
  FROM updated
  RETURNING id
)
SELECT
  updated.assignment_id::text AS assignment_id,
  updated.student_ref::text AS student_ref,
  updated.status,
  updated.current_reason,
  updated.decided_by_email,
  updated.decided_at
FROM updated;`;
