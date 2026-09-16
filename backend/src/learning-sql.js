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
    SELECT jsonb_agg(jsonb_build_object(
      'blockId', release.block_id::text,
      'checkpoint', release.checkpoint,
      'status', release.status,
      'releaseVersion', release.release_version,
      'releasedAt', release.released_at
    ) ORDER BY release.checkpoint)
    FROM learning.assignment_block_release AS release
    WHERE release.assignment_id = assignment.id
  ), '[]'::jsonb) AS block_releases,
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

export const fetchLearningAttemptCheckpointsSql = `SELECT DISTINCT ON (block_id)
  id::text AS checkpoint_submission_id,
  block_id::text AS block_id,
  checkpoint,
  completeness,
  missing_item_version_ids,
  submitted_at
FROM learning.checkpoint_submission
WHERE attempt_id = $1::uuid
ORDER BY block_id, checkpoint_revision DESC, submitted_at DESC;`;

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

// Ghi toàn bộ critical path của một lần nộp trong một câu SQL. API truyền hai mảng
// JSON đã kiểm identity; PostgreSQL bung mảng theo lô thay vì nhận một INSERT cho mỗi câu.
export const finalizeLearningSubmissionSql = `WITH
previous_attendance AS (
  SELECT status
  FROM learning.attendance_record
  WHERE assignment_id = $3::uuid
    AND student_ref = $5::uuid
  FOR UPDATE
),
saved_submission AS (
  INSERT INTO learning.submission (
    id, attempt_id, assignment_id, form_version_id, student_ref, source_revision,
    response_payload, response_hash, completeness, grading_status, receipt, submitted_at
  ) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1,
    $6::jsonb, $7, $8, $9, $10::jsonb, $11::timestamptz
  )
  RETURNING id
),
saved_response_items AS (
  INSERT INTO learning.response_item (
    submission_id, item_version_id, item_family_id, position, interaction_type,
    pedagogical_type_code, skill_codes, response_value, answer_state
  )
  SELECT
    saved_submission.id,
    item.item_version_id,
    item.item_family_id,
    item.position,
    item.interaction_type,
    item.pedagogical_type_code,
    item.skill_codes,
    item.response_value,
    item.answer_state
  FROM saved_submission
  CROSS JOIN jsonb_to_recordset($12::jsonb) AS item(
    item_version_id uuid,
    item_family_id uuid,
    position integer,
    interaction_type text,
    pedagogical_type_code text,
    skill_codes jsonb,
    response_value jsonb,
    answer_state text
  )
  RETURNING item_version_id
),
saved_grading_run AS (
  INSERT INTO learning.grading_run (
    submission_id, grader_version, operation_key, idempotency_key, status,
    result_json, completed_at
  )
  SELECT
    saved_submission.id, $13, $14, $15, $9, $16::jsonb,
    CASE WHEN $9 = 'complete' THEN now() ELSE NULL END
  FROM saved_submission
  RETURNING id
),
saved_grading_items AS (
  INSERT INTO learning.grading_result_item (
    grading_run_id, item_version_id, raw_answer, normalized_answer, expected_answer,
    answer_state, verdict, score_earned, max_score
  )
  SELECT
    saved_grading_run.id,
    item.item_version_id,
    item.raw_answer,
    item.normalized_answer,
    item.expected_answer,
    item.answer_state,
    item.verdict,
    item.score_earned,
    item.max_score
  FROM saved_grading_run
  CROSS JOIN jsonb_to_recordset($17::jsonb) AS item(
    item_version_id uuid,
    raw_answer jsonb,
    normalized_answer jsonb,
    expected_answer jsonb,
    answer_state text,
    verdict text,
    score_earned numeric,
    max_score numeric
  )
  RETURNING item_version_id
),
saved_attendance AS (
  INSERT INTO learning.attendance_record (
    assignment_id, student_ref, status, source_submission_id, current_reason,
    decided_at, updated_at
  )
  SELECT $3::uuid, $5::uuid, $18, saved_submission.id, $19, now(), now()
  FROM saved_submission
  ON CONFLICT (assignment_id, student_ref) DO UPDATE SET
    status = EXCLUDED.status,
    source_submission_id = EXCLUDED.source_submission_id,
    current_reason = EXCLUDED.current_reason,
    decided_by_email = NULL,
    decided_at = now(),
    updated_at = now()
  RETURNING assignment_id, student_ref
),
saved_attendance_event AS (
  INSERT INTO learning.attendance_event (
    assignment_id, student_ref, previous_status, new_status, source_submission_id,
    reason, actor_type, operation_key
  )
  SELECT
    saved_attendance.assignment_id,
    saved_attendance.student_ref,
    previous_attendance.status,
    $18,
    saved_submission.id,
    $19,
    'system',
    $20
  FROM saved_attendance
  CROSS JOIN saved_submission
  LEFT JOIN previous_attendance ON true
  RETURNING id
),
saved_evidence AS (
  INSERT INTO learning.evidence_event (
    id, source_system, source_record_id, source_revision, entity_key, unit_key,
    operation_key, idempotency_key, organization_key, course_code,
    erp_course_class_id, session_number, student_ref, form_version_id,
    assignment_id, submission_id, visibility, payload, content_hash,
    renderer_version, markdown, occurred_at, ingested_at
  )
  SELECT
    $21::uuid, $22, $23, $24, $25, $26, $27, $28, $29, $30,
    $31::bigint, $32, $5::uuid, $4::uuid, $3::uuid, saved_submission.id,
    $33, $34::jsonb, $35, $36, $37, $11::timestamptz, $11::timestamptz
  FROM saved_submission
  RETURNING id
),
saved_job AS (
  INSERT INTO learning.outbox_job (
    job_type, entity_key, unit_key, operation_key, idempotency_key, payload
  )
  SELECT 'analyze_submission', $25, $26, $38, $39, $40::jsonb
  FROM saved_evidence
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id
),
completed_attempt AS (
  UPDATE learning.attempt
  SET status = 'submitted', submitted_at = $11::timestamptz, updated_at = now()
  WHERE id = $2::uuid
    AND status = 'active'
  RETURNING id
)
SELECT
  saved_submission.id::text AS submission_id,
  saved_grading_run.id::text AS grading_run_id,
  (SELECT count(*)::int FROM saved_response_items) AS response_item_count,
  (SELECT count(*)::int FROM saved_grading_items) AS grading_item_count,
  EXISTS (SELECT 1 FROM saved_attendance_event) AS attendance_event_saved,
  EXISTS (SELECT 1 FROM saved_evidence) AS evidence_saved,
  EXISTS (SELECT 1 FROM saved_job) AS outbox_saved,
  EXISTS (SELECT 1 FROM completed_attempt) AS attempt_completed
FROM saved_submission
CROSS JOIN saved_grading_run;`;

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
  default_config,
  sharing_scope,
  approved_by_email,
  COALESCE((
    SELECT jsonb_agg(skill.skill_code ORDER BY skill.skill_code)
    FROM learning.question_library_skill AS skill
    WHERE skill.question_library_id = learning.question_library.id
  ), '[]'::jsonb) AS skill_codes
FROM learning.question_library
WHERE status = 'active'
  AND sharing_scope = 'center'
  AND approved_by_email IS NOT NULL
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
  library.sharing_scope,
  COALESCE((
    SELECT jsonb_agg(skill.skill_code ORDER BY skill.skill_code)
    FROM learning.question_library_skill AS skill
    WHERE skill.question_library_id = library.id
  ), '[]'::jsonb) AS skill_codes,
  requested.ordinality::int AS ordinality
FROM requested
JOIN learning.question_library AS library ON library.id = requested.item_id
WHERE library.status = 'active'
  AND library.sharing_scope = 'center'
  AND library.approved_by_email IS NOT NULL
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

export const insertLearningAssignmentBlockReleaseSql = `INSERT INTO learning.assignment_block_release (
  assignment_id, block_id, checkpoint, status, release_version, updated_by_email, released_at
) VALUES ($1::uuid, $2::uuid, $3, $4, 1, $5, CASE WHEN $4 = 'open' THEN now() ELSE NULL END);`;

export const fetchLearningBlockReleaseSql = `SELECT
  assignment_id::text AS assignment_id,
  block_id::text AS block_id,
  checkpoint,
  status,
  release_version,
  released_at
FROM learning.assignment_block_release
WHERE assignment_id = $1::uuid AND block_id = $2::uuid;`;

export const findLearningCheckpointSubmissionSql = `SELECT
  checkpoint_submission.id::text AS checkpoint_submission_id,
  checkpoint_submission.attempt_id::text AS attempt_id,
  checkpoint_submission.assignment_id::text AS assignment_id,
  checkpoint_submission.student_ref::text AS student_ref,
  checkpoint_submission.block_id::text AS block_id,
  checkpoint_submission.checkpoint,
  checkpoint_submission.checkpoint_revision,
  checkpoint_submission.response_hash,
  checkpoint_submission.completeness,
  checkpoint_submission.missing_item_version_ids,
  checkpoint_submission.submitted_at
FROM learning.checkpoint_submission
JOIN learning.attempt ON attempt.id = checkpoint_submission.attempt_id
WHERE learning.attempt.attempt_token = $1::uuid
  AND checkpoint_submission.block_id = $2::uuid
  AND checkpoint_submission.idempotency_key = $3;`;

export const insertLearningCheckpointSubmissionSql = `INSERT INTO learning.checkpoint_submission (
  id, attempt_id, assignment_id, form_version_id, student_ref, block_id, checkpoint,
  checkpoint_revision, response_payload, response_hash, completeness, missing_item_version_ids,
  operation_key, idempotency_key, submitted_at
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7,
  $8, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $15::timestamptz
)
RETURNING id::text AS checkpoint_submission_id, submitted_at;`;

export const updateLearningBlockReleaseSql = `WITH target AS (
  SELECT assignment.id, release.block_id, release.checkpoint, release.status, release.release_version
  FROM learning.form_assignment AS assignment
  JOIN learning.assignment_block_release AS release ON release.assignment_id = assignment.id
  WHERE assignment.id = $1::uuid
    AND release.block_id = $2::uuid
    AND (
      $6::boolean
      OR EXISTS (
        SELECT 1 FROM mapping.reviewer_class_access AS access
        WHERE access.reviewer_email = $5
          AND access.erp_course_class_id = assignment.erp_course_class_id
      )
    )
  FOR UPDATE OF release
), replay AS (
  SELECT assignment_id, block_id, checkpoint, new_status AS status, release_version, created_at AS released_at
  FROM learning.assignment_block_release_event
  WHERE idempotency_key = $4
), updated AS (
  UPDATE learning.assignment_block_release AS release
  SET status = $3,
      release_version = target.release_version + 1,
      updated_by_email = $5,
      released_at = CASE WHEN $3 = 'open' THEN now() ELSE release.released_at END,
      updated_at = now()
  FROM target
  WHERE release.assignment_id = target.id
    AND release.block_id = target.block_id
    AND NOT EXISTS (SELECT 1 FROM replay)
  RETURNING release.assignment_id, release.block_id, release.checkpoint, target.status AS previous_status,
            release.status, release.release_version, release.released_at
), event AS (
  INSERT INTO learning.assignment_block_release_event (
    assignment_id, block_id, checkpoint, previous_status, new_status, release_version,
    actor_email, operation_key, idempotency_key
  )
  SELECT assignment_id, block_id, checkpoint, previous_status, status, release_version, $5, $7, $4
  FROM updated
  RETURNING assignment_id, block_id, checkpoint, new_status AS status, release_version, created_at AS released_at
)
SELECT assignment_id::text, block_id::text, checkpoint, status, release_version, released_at FROM event
UNION ALL
SELECT assignment_id::text, block_id::text, checkpoint, status, release_version, released_at FROM replay
LIMIT 1;`;

export const markLearningReportDeliveredSql = `WITH target AS (
  SELECT report.id, report.student_ref
  FROM learning.periodic_report AS report
  JOIN learning.teacher_human_note AS note ON note.report_id = report.id
  JOIN learning.form_assignment AS assignment
    ON assignment.erp_course_class_id = report.erp_course_class_id
    AND assignment.id = $2::uuid
  WHERE report.id = $1::uuid
    AND report.student_ref = $3::uuid
    AND report.status IN ('approved', 'published')
    AND (
      $7::boolean
      OR EXISTS (
        SELECT 1 FROM mapping.reviewer_class_access AS access
        WHERE access.reviewer_email = $6
          AND access.erp_course_class_id = assignment.erp_course_class_id
      )
    )
), published AS (
  UPDATE learning.periodic_report AS report
  SET status = 'published',
      published_at = COALESCE(report.published_at, now()),
      updated_at = now()
  FROM target
  WHERE report.id = target.id
  RETURNING report.id, report.student_ref
), inserted AS (
  INSERT INTO learning.report_delivery (
    report_id, student_ref, channel, status, operation_key, idempotency_key,
    sent_by_email, attempted_at, sent_at
  )
  SELECT id, student_ref, 'manual', 'sent', $5, $4, $6, now(), now() FROM published
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING report_id, student_ref, channel, status, sent_by_email, sent_at
)
SELECT report_id::text, student_ref::text, channel, status, sent_by_email, sent_at FROM inserted
UNION ALL
SELECT report_id::text, student_ref::text, channel, status, sent_by_email, sent_at
FROM learning.report_delivery WHERE idempotency_key = $4
LIMIT 1;`;

export const upsertLearningTeacherHumanNoteSql = `WITH target AS (
  SELECT report.id
  FROM learning.periodic_report AS report
  JOIN learning.form_assignment AS assignment
    ON assignment.erp_course_class_id = report.erp_course_class_id
    AND assignment.id = $2::uuid
  WHERE report.id = $1::uuid
    AND report.student_ref = $3::uuid
    AND report.status IN ('ready_for_review', 'approved', 'published')
    AND (
      $6::boolean
      OR EXISTS (
        SELECT 1 FROM mapping.reviewer_class_access AS access
        WHERE access.reviewer_email = $5
          AND access.erp_course_class_id = assignment.erp_course_class_id
      )
    )
), saved AS (
  INSERT INTO learning.teacher_human_note (report_id, teacher_email, note_text, updated_at)
  SELECT id, $5, $4, now() FROM target
  ON CONFLICT (report_id) DO UPDATE SET
    teacher_email = EXCLUDED.teacher_email,
    note_text = EXCLUDED.note_text,
    updated_at = now()
  RETURNING report_id, teacher_email, note_text, updated_at
), approved AS (
  UPDATE learning.periodic_report AS report
  SET status = CASE WHEN report.status = 'published' THEN 'published' ELSE 'approved' END,
      approved_by_email = $5,
      approved_at = now(),
      updated_at = now()
  FROM saved
  WHERE report.id = saved.report_id
  RETURNING report.id
)
SELECT saved.report_id::text, saved.teacher_email, saved.note_text, saved.updated_at
FROM saved JOIN approved ON approved.id = saved.report_id;`;

export const authorizeLearningProgressLinkTargetSql = `SELECT
  assignment.erp_course_class_id::text AS class_id,
  assignment.class_name_snapshot AS class_name,
  roster.student_ref::text AS student_ref,
  roster.student_name_snapshot AS student_name
FROM learning.form_assignment AS assignment
JOIN learning.form_assignment_roster AS roster
  ON roster.assignment_id = assignment.id
  AND roster.student_ref = $2::uuid
WHERE assignment.id = $1::uuid
  AND (
    $4::boolean
    OR EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_access AS access
      WHERE access.reviewer_email = $3
        AND access.erp_course_class_id = assignment.erp_course_class_id
    )
  );`;

export const findLearningProgressAccessByOperationSql = `SELECT
  id::text,
  erp_course_class_id::text AS class_id,
  student_ref::text,
  token_hash,
  status,
  expires_at,
  operation_key
FROM learning.student_progress_access
WHERE operation_key = $1;`;

export const revokeLearningProgressAccessSql = `UPDATE learning.student_progress_access
  SET status = 'revoked', revoked_at = now(), updated_at = now()
  WHERE erp_course_class_id = $1::bigint
    AND student_ref = $2::uuid
    AND status = 'active';`;

export const rotateLearningProgressAccessSql = `INSERT INTO learning.student_progress_access (
    id, erp_course_class_id, student_ref, token_hash, status, expires_at,
    created_by_email, operation_key, idempotency_key
  ) VALUES (
    $1::uuid, $2::bigint, $3::uuid, $4, 'active', $5::timestamptz,
    $6, $7, $8
  )
  RETURNING
  id::text,
  erp_course_class_id::text AS class_id,
  student_ref::text,
  status,
  expires_at,
  created_at;`;

export const fetchStudentCourseJourneySql = `WITH access AS (
  SELECT erp_course_class_id, student_ref, expires_at
  FROM learning.student_progress_access
  WHERE token_hash = $1
    AND status = 'active'
    AND expires_at > now()
), identity_snapshot AS (
  SELECT
    access.erp_course_class_id,
    access.student_ref,
    access.expires_at,
    roster.student_name_snapshot AS student_name,
    assignment.class_name_snapshot AS class_name
  FROM access
  JOIN LATERAL (
    SELECT candidate.*
    FROM learning.form_assignment AS candidate
    JOIN learning.form_assignment_roster AS candidate_roster
      ON candidate_roster.assignment_id = candidate.id
      AND candidate_roster.student_ref = access.student_ref
    WHERE candidate.erp_course_class_id = access.erp_course_class_id
    ORDER BY candidate.session_number DESC, candidate.created_at DESC
    LIMIT 1
  ) AS assignment ON true
  JOIN learning.form_assignment_roster AS roster
    ON roster.assignment_id = assignment.id
    AND roster.student_ref = access.student_ref
), session_rows AS (
  SELECT
    assignment.id,
    assignment.session_number,
    assignment.title,
    assignment.status AS assignment_status,
    student_status.attempt_status,
    student_status.completeness,
    student_status.grading_status,
    student_status.submitted_at,
    student_status.attendance_status,
    COALESCE(evidence.evidence_count, 0) AS evidence_count,
    COALESCE(evidence.source_systems, '[]'::jsonb) AS evidence_sources,
    CASE WHEN after_report.id IS NULL THEN NULL ELSE jsonb_build_object(
      'reportId', after_report.id::text,
      'fromSessionNumber', after_report.from_session_number,
      'toSessionNumber', after_report.to_session_number,
      'systemOutput', after_report.system_output,
      'systemMarkdown', after_report.system_markdown,
      'humanNote', after_report.note_text,
      'publishedAt', after_report.published_at
    ) END AS after_session_report
  FROM access
  JOIN learning.form_assignment AS assignment
    ON assignment.erp_course_class_id = access.erp_course_class_id
  JOIN learning.form_assignment_roster AS roster
    ON roster.assignment_id = assignment.id
    AND roster.student_ref = access.student_ref
  LEFT JOIN learning.assignment_student_status AS student_status
    ON student_status.assignment_id = assignment.id
    AND student_status.student_ref = access.student_ref
  LEFT JOIN LATERAL (
    SELECT
      count(*)::integer AS evidence_count,
      jsonb_agg(DISTINCT event.source_system) AS source_systems
    FROM learning.evidence_event AS event
    WHERE event.erp_course_class_id = access.erp_course_class_id
      AND event.student_ref = access.student_ref
      AND event.session_number = assignment.session_number
      AND event.visibility = 'student_visible'
  ) AS evidence ON true
  LEFT JOIN LATERAL (
    SELECT report.*, note.note_text
    FROM learning.periodic_report AS report
    LEFT JOIN learning.teacher_human_note AS note ON note.report_id = report.id
    WHERE report.erp_course_class_id = access.erp_course_class_id
      AND report.student_ref = access.student_ref
      AND report.report_kind = 'after_session'
      AND report.assignment_id = assignment.id
      AND report.status = 'published'
    ORDER BY report.published_at DESC, report.id DESC
    LIMIT 1
  ) AS after_report ON true
  WHERE assignment.status IN ('published', 'closed')
), sessions AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'assignmentId', id::text,
    'sessionNumber', session_number,
    'title', title,
    'assignmentStatus', assignment_status,
    'attemptStatus', attempt_status,
    'completeness', completeness,
    'gradingStatus', grading_status,
    'submittedAt', submitted_at,
    'attendanceStatus', attendance_status,
    'evidenceCount', evidence_count,
    'evidenceSources', evidence_sources,
    'afterSessionReport', after_session_report
  ) ORDER BY session_number, id), '[]'::jsonb) AS items
  FROM session_rows
), reports AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'reportId', report.id::text,
    'reportKind', report.report_kind,
    'fromSessionNumber', report.from_session_number,
    'toSessionNumber', report.to_session_number,
    'systemOutput', report.system_output,
    'systemMarkdown', report.system_markdown,
    'humanNote', note.note_text,
    'publishedAt', report.published_at
  ) ORDER BY report.to_session_number, report.published_at, report.id), '[]'::jsonb) AS items
  FROM access
  JOIN learning.periodic_report AS report
    ON report.erp_course_class_id = access.erp_course_class_id
    AND report.student_ref = access.student_ref
    AND report.report_kind = 'periodic'
    AND report.status = 'published'
  LEFT JOIN learning.teacher_human_note AS note ON note.report_id = report.id
)
SELECT
  identity_snapshot.student_ref::text AS student_ref,
  identity_snapshot.student_name,
  identity_snapshot.erp_course_class_id::text AS class_id,
  identity_snapshot.class_name,
  identity_snapshot.expires_at,
  sessions.items AS sessions,
  reports.items AS reports
FROM identity_snapshot
CROSS JOIN sessions
CROSS JOIN reports;`;

export const fetchLearningTeacherDashboardSql = `SELECT
  assignment.id::text AS assignment_id,
  assignment.title,
  assignment.session_number,
  assignment.class_name_snapshot AS class_name,
  assignment.public_token::text AS public_token,
  assignment.status,
  assignment.form_version_id::text AS form_version_id,
  (SELECT version.public_definition FROM learning.form_version AS version
    WHERE version.id = assignment.form_version_id) AS public_definition,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'blockId', release.block_id::text,
      'checkpoint', release.checkpoint,
      'status', release.status,
      'releaseVersion', release.release_version,
      'releasedAt', release.released_at
    ) ORDER BY release.checkpoint)
    FROM learning.assignment_block_release AS release
    WHERE release.assignment_id = assignment.id
  ), '[]'::jsonb) AS block_releases,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'insightId', insight.id::text,
      'category', insight.category,
      'skillCode', insight.skill_code,
      'title', insight.title,
      'summary', insight.summary,
      'affectedCount', jsonb_array_length(insight.affected_student_refs),
      'status', insight.status
    ) ORDER BY insight.category, insight.title)
    FROM learning.class_session_insight AS insight
    WHERE insight.assignment_id = assignment.id
      AND insight.status IN ('ready_for_review', 'approved')
  ), '[]'::jsonb) AS class_insights,
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
      'checkpoints', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'blockId', checkpoint.block_id::text,
          'checkpoint', checkpoint.checkpoint,
          'completeness', checkpoint.completeness,
          'submittedAt', checkpoint.submitted_at
        ) ORDER BY checkpoint.checkpoint)
        FROM learning.checkpoint_submission AS checkpoint
        WHERE checkpoint.attempt_id = status.attempt_id
      ), '[]'::jsonb),
      'evidenceCount', COALESCE(evidence.evidence_count, 0),
      'evidenceSources', COALESCE(evidence.source_systems, '[]'::jsonb),
      'latestReport', CASE WHEN report.id IS NULL THEN NULL ELSE jsonb_build_object(
        'reportId', report.id::text,
        'status', report.status,
        'fromSessionNumber', report.from_session_number,
        'toSessionNumber', report.to_session_number,
        'systemOutput', report.system_output,
        'systemMarkdown', report.system_markdown,
        'humanNote', report.note_text,
        'delivery', report.delivery
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
  SELECT periodic.*, note.note_text,
    (SELECT jsonb_build_object(
      'status', delivery.status,
      'channel', delivery.channel,
      'sentAt', delivery.sent_at,
      'sentBy', delivery.sent_by_email
    ) FROM learning.report_delivery AS delivery
      WHERE delivery.report_id = periodic.id
      ORDER BY delivery.updated_at DESC, delivery.id DESC
      LIMIT 1) AS delivery
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

export const fetchLearningTeacherLiveDraftsSql = `WITH authorized_assignment AS (
  SELECT assignment.id, assignment.form_version_id
  FROM learning.form_assignment AS assignment
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
),
roster_state AS (
  SELECT
    roster.assignment_id,
    roster.student_ref,
    roster.student_name_snapshot,
    roster.display_discriminator,
    attempt.id AS attempt_id,
    attempt.status AS attempt_status,
    attempt.draft_revision,
    attempt.draft_updated_at,
    attempt.draft,
    submission.id AS submission_id,
    submission.response_payload AS final_responses,
    submission.submitted_at,
    grading.result_json AS grading_result
  FROM authorized_assignment AS assignment
  JOIN learning.form_assignment_roster AS roster ON roster.assignment_id = assignment.id
  LEFT JOIN LATERAL (
    SELECT candidate.*
    FROM learning.attempt AS candidate
    WHERE candidate.assignment_id = roster.assignment_id
      AND candidate.student_ref = roster.student_ref
      AND candidate.status <> 'superseded'
    ORDER BY candidate.created_at DESC, candidate.id DESC
    LIMIT 1
  ) AS attempt ON true
  LEFT JOIN learning.submission AS submission ON submission.attempt_id = attempt.id
  LEFT JOIN LATERAL (
    SELECT run.result_json
    FROM learning.grading_run AS run
    WHERE run.submission_id = submission.id
    ORDER BY run.created_at DESC, run.id DESC
    LIMIT 1
  ) AS grading ON true
)
SELECT
  $1::uuid::text AS assignment_id,
  now() AS generated_at,
  COALESCE(jsonb_agg(jsonb_build_object(
    'studentRef', roster_state.student_ref::text,
    'name', roster_state.student_name_snapshot,
    'discriminator', roster_state.display_discriminator,
    'attemptId', roster_state.attempt_id::text,
    'attemptStatus', roster_state.attempt_status,
    'draftRevision', COALESCE(roster_state.draft_revision, 0),
    'draftUpdatedAt', roster_state.draft_updated_at,
    'draftResponses', COALESCE(roster_state.draft, '{}'::jsonb),
    'submissionId', roster_state.submission_id::text,
    'submittedAt', roster_state.submitted_at,
    'finalResponses', COALESCE(roster_state.final_responses, '{}'::jsonb),
    'gradingResult', roster_state.grading_result
  ) ORDER BY roster_state.student_name_snapshot, roster_state.student_ref), '[]'::jsonb) AS students
FROM authorized_assignment
LEFT JOIN roster_state ON roster_state.assignment_id = authorized_assignment.id
GROUP BY authorized_assignment.id;`;

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
