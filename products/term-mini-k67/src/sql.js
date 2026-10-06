// SQL Term/Mini được ghim từ bản chạy; mapping ở đây phải là ngữ cảnh trong DB K67 riêng.
// Quyền và dữ liệu được đọc trong cùng snapshot SQL. Không dùng cờ admin đã giữ từ request cũ.
// Các đối số dưới đây là vị trí tham số/tên cột cố định trong source, không nhận chuỗi từ người dùng.
function teacherCanReadClass(email, authorization, classId) {
  return `(
    (${authorization}::jsonb->>'source' = 'legacy' AND ${email} = 'legacy@mapping.local')
    OR EXISTS (
      SELECT 1 FROM mapping.reviewer_account AS current_account
      WHERE current_account.email = ${email} AND current_account.status = 'active'
        AND (
          (${authorization}::jsonb->>'source' = 'google_bearer'
            AND current_account.google_subject = ${authorization}::jsonb->>'googleSubject')
          OR (${authorization}::jsonb->>'source' = 'session' AND EXISTS (
            SELECT 1 FROM mapping.reviewer_session AS current_session
            WHERE current_session.token_hash = decode(${authorization}::jsonb->>'tokenHash', 'hex')
              AND current_session.reviewer_email = current_account.email
              AND current_session.google_subject = current_account.google_subject
              AND current_session.revoked_at IS NULL
              AND current_session.idle_expires_at > now() AND current_session.absolute_expires_at > now()
          ))
        )
        AND (current_account.role = 'admin' OR current_account.can_access_all_classes OR EXISTS (
          SELECT 1 FROM mapping.reviewer_class_access AS current_access
          WHERE current_access.reviewer_email = current_account.email AND current_access.erp_course_class_id = ${classId}
        ))
    )
  )`;
}

export const listTermTestRosterSql = `WITH definition AS (
  SELECT slug, title, version
  FROM assessment.test_definition
  WHERE slug = $2
    AND is_active = true
),
target_classes AS (
  SELECT erp_course_class_id, erp_class_name_snapshot
  FROM mapping.classroom_course_mapping
  WHERE upper(trim(erp_class_name_snapshot)) = upper(trim($1))
),
roster_mode AS (
  SELECT EXISTS (
    SELECT 1
    FROM assessment.term_test_roster AS roster
    JOIN target_classes AS target
      ON target.erp_course_class_id = roster.erp_course_class_id
    WHERE roster.test_slug = $2
  ) AS has_curated_roster
),
students AS (
  SELECT
    roster.student_ref::text AS student_ref,
    roster.student_name_snapshot AS student_name
  FROM assessment.term_test_roster AS roster
  JOIN target_classes AS target
    ON target.erp_course_class_id = roster.erp_course_class_id
  WHERE roster.test_slug = $2

  UNION ALL

  SELECT
    review.public_id::text AS student_ref,
    review.erp_student_name_snapshot AS student_name
  FROM mapping.student_mapping_review AS review
  JOIN target_classes AS target
    ON target.erp_course_class_id = review.erp_course_class_id
  CROSS JOIN roster_mode
  WHERE roster_mode.has_curated_roster = false
    AND review.status <> 'superseded'
)
SELECT
  definition.slug AS test_slug,
  definition.title AS test_title,
  definition.version AS definition_version,
  (SELECT count(*)::int FROM target_classes) AS class_count,
  (SELECT erp_course_class_id::text FROM target_classes LIMIT 1) AS class_id,
  (SELECT erp_class_name_snapshot FROM target_classes LIMIT 1) AS class_name,
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object('ref', students.student_ref, 'name', students.student_name)
      ORDER BY students.student_name
    )
    FROM students
  ), '[]'::jsonb) AS students
FROM definition;`;

export const registerTemporaryTermTestStudentSql = `WITH definition AS (
  SELECT slug, title, version
  FROM assessment.test_definition
  WHERE slug = $2
    AND slug ~ '^mini-test-[a-z0-9-]+$'
    AND is_active = true
),
target_classes AS (
  SELECT erp_course_class_id, erp_class_name_snapshot
  FROM mapping.classroom_course_mapping
  WHERE upper(trim(erp_class_name_snapshot)) = upper(trim($1))
),
registered AS (
  INSERT INTO assessment.term_test_temporary_student (
    test_slug,
    erp_course_class_id,
    temporary_code_normalized,
    student_name_snapshot,
    student_name_key
  )
  SELECT
    definition.slug,
    target.erp_course_class_id,
    $3,
    $4,
    $5
  FROM definition
  CROSS JOIN target_classes AS target
  WHERE (SELECT count(*) FROM target_classes) = 1
  ON CONFLICT (test_slug, erp_course_class_id, temporary_code_normalized) DO UPDATE SET
    updated_at = assessment.term_test_temporary_student.updated_at
  RETURNING
    student_ref::text AS student_ref,
    student_name_snapshot AS student_name,
    student_name_key,
    active
)
SELECT
  definition.slug AS test_slug,
  definition.title AS test_title,
  definition.version AS definition_version,
  (SELECT count(*)::int FROM target_classes) AS class_count,
  (SELECT erp_course_class_id::text FROM target_classes LIMIT 1) AS class_id,
  (SELECT erp_class_name_snapshot FROM target_classes LIMIT 1) AS class_name,
  registered.student_ref,
  registered.student_name,
  registered.active,
  registered.student_name_key = $5 AS name_matches
FROM definition
LEFT JOIN registered ON true;`;

export const resetDemoTermTestStudentSql = `SELECT deleted_attempts, deleted_sessions
FROM assessment.reset_demo_term_test_student($1, $2, $3::uuid);`;

export const findStudentForTermTestSql = `WITH target_classes AS (
  SELECT erp_course_class_id, erp_class_name_snapshot
  FROM mapping.classroom_course_mapping
  WHERE upper(trim(erp_class_name_snapshot)) = upper(trim($1))
),
roster_mode AS (
  SELECT EXISTS (
    SELECT 1
    FROM assessment.term_test_roster AS roster
    JOIN target_classes AS target
      ON target.erp_course_class_id = roster.erp_course_class_id
    WHERE roster.test_slug = $2
  ) AS has_curated_roster
),
eligible_student AS (
  SELECT
    roster.erp_course_class_id,
    roster.erp_student_contact_id,
    roster.student_name_snapshot AS student_name
  FROM assessment.term_test_roster AS roster
  JOIN target_classes AS target
    ON target.erp_course_class_id = roster.erp_course_class_id
  WHERE roster.test_slug = $2
    AND roster.student_ref = $3::uuid

  UNION ALL

  SELECT
    review.erp_course_class_id,
    review.erp_student_contact_id,
    review.erp_student_name_snapshot AS student_name
  FROM mapping.student_mapping_review AS review
  JOIN target_classes AS target
    ON target.erp_course_class_id = review.erp_course_class_id
  CROSS JOIN roster_mode
  WHERE roster_mode.has_curated_roster = false
    AND review.public_id = $3::uuid
    AND review.status <> 'superseded'

  UNION ALL

  SELECT
    temporary.erp_course_class_id,
    -temporary.temporary_student_id AS erp_student_contact_id,
    temporary.student_name_snapshot AS student_name
  FROM assessment.term_test_temporary_student AS temporary
  JOIN target_classes AS target
    ON target.erp_course_class_id = temporary.erp_course_class_id
  WHERE temporary.test_slug = $2
    AND temporary.student_ref = $3::uuid
    AND temporary.active = true
)
SELECT
  definition.slug AS test_slug,
  definition.title AS test_title,
  definition.version AS definition_version,
  definition.listening_band_adjustment,
  definition.listening_definition,
  definition.reading_definition,
  student.erp_course_class_id::text AS class_id,
  target.erp_class_name_snapshot AS class_name,
  student.erp_student_contact_id::text AS student_id,
  student.student_name
FROM assessment.test_definition AS definition
JOIN eligible_student AS student ON true
JOIN target_classes AS target
  ON target.erp_course_class_id = student.erp_course_class_id
WHERE definition.slug = $2
  AND definition.is_active = true;`;

export const insertTermTestExamSessionSql = `WITH inserted AS (
  INSERT INTO assessment.term_test_exam_session (
    test_slug,
    definition_version,
    erp_course_class_id,
    class_name_snapshot,
    erp_student_contact_id,
    student_name_snapshot,
    listening_resume_offset_seconds
  ) VALUES ($1, $2::int, $3::bigint, $4, $5::bigint, $6, $7::int)
  ON CONFLICT DO NOTHING
  RETURNING *
), resolved AS (
  SELECT inserted.*, 0 AS match_priority
  FROM inserted
  UNION ALL
  SELECT existing.*, 1 AS match_priority
  FROM assessment.term_test_exam_session AS existing
  WHERE existing.test_slug = $1
    AND existing.definition_version = $2::int
    AND existing.erp_course_class_id = $3::bigint
    AND existing.erp_student_contact_id = $5::bigint
    AND existing.listening_submitted_at IS NULL
    AND existing.superseded_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM inserted)
)
SELECT
  id::text AS exam_session_token,
  test_slug,
  prepared_at,
  attempt_mode,
  listening_started_at,
  listening_deadline_at,
  listening_draft,
  listening_draft_revision,
  listening_submitted_at,
  attempt_id::text AS attempt_token,
  now() AS server_now
FROM resolved
ORDER BY match_priority
LIMIT 1;`;

export const resumeTermTestExamSessionSql = `SELECT
  id::text AS exam_session_token,
  test_slug,
  attempt_mode,
  prepared_at,
  listening_started_at,
  listening_deadline_at,
  listening_draft,
  listening_draft_revision,
  listening_submitted_at,
  attempt_id::text AS attempt_token,
  now() AS server_now
FROM assessment.term_test_exam_session
WHERE id = $1::uuid
  AND test_slug = $2
  AND erp_course_class_id = $3::bigint
  AND erp_student_contact_id = $4::bigint
  AND superseded_at IS NULL
  AND prepared_at >= now() - interval '8 hours';`;

export const supersedeStaleTermTestExamSessionsSql = `UPDATE assessment.term_test_exam_session
SET
  superseded_at = now(),
  updated_at = now()
WHERE test_slug = $1
  AND definition_version = $2::int
  AND erp_course_class_id = $3::bigint
  AND erp_student_contact_id = $4::bigint
  AND listening_submitted_at IS NULL
  AND superseded_at IS NULL
  AND attempt_mode <> 'answer_sheet'
  AND prepared_at < now() - interval '8 hours';`;

export const findLatestTermTestAttemptForStudentSql = `SELECT
  attempt.id::text AS attempt_token,
  attempt.attempt_mode,
  attempt.exam_session_id::text AS exam_session_token,
  attempt.student_name_snapshot AS student_name,
  attempt.listening_submitted_at,
  attempt.reading_started_at,
  attempt.reading_deadline_at,
  attempt.reading_draft,
  attempt.reading_draft_revision,
  attempt.completed_at,
  attempt.writing_started_at,
  attempt.writing_deadline_at,
  attempt.writing_submitted_at,
  session.listening_started_at,
  session.listening_deadline_at,
  now() AS server_now
FROM assessment.term_test_attempt AS attempt
LEFT JOIN assessment.term_test_exam_session AS session
  ON session.id = attempt.exam_session_id
WHERE attempt.test_slug = $1
  AND attempt.definition_version = $2::int
  AND attempt.erp_course_class_id = $3::bigint
  AND attempt.erp_student_contact_id = $4::bigint
  AND attempt.listening_submitted_at IS NOT NULL
  AND attempt.superseded_at IS NULL
ORDER BY attempt.listening_submitted_at DESC, attempt.created_at DESC
LIMIT 1;`;

export const findActiveTermTestAttemptForStudentSql = `SELECT
  attempt.id::text AS attempt_token,
  attempt.exam_session_id::text AS exam_session_token,
  attempt.student_name_snapshot AS student_name,
  attempt.listening_submitted_at,
  attempt.reading_started_at,
  attempt.reading_deadline_at,
  attempt.reading_draft,
  attempt.reading_draft_revision,
  now() AS server_now
FROM assessment.term_test_attempt AS attempt
WHERE attempt.test_slug = $1
  AND attempt.definition_version = $2::int
  AND attempt.erp_course_class_id = $3::bigint
  AND attempt.erp_student_contact_id = $4::bigint
  AND attempt.listening_submitted_at IS NOT NULL
  AND attempt.completed_at IS NULL
  AND attempt.superseded_at IS NULL
  AND attempt.created_at >= now() - interval '8 hours'
ORDER BY
  attempt.reading_draft_updated_at DESC NULLS LAST,
  attempt.reading_started_at DESC NULLS LAST,
  attempt.listening_submitted_at DESC
LIMIT 1;`;

export const resumeTermTestAttemptContentSql = `SELECT
  attempt.id::text AS attempt_token,
  attempt.exam_session_id::text AS exam_session_token,
  attempt.student_name_snapshot AS student_name,
  attempt.listening_submitted_at,
  attempt.reading_started_at,
  attempt.reading_deadline_at,
  attempt.reading_draft,
  attempt.reading_draft_revision,
  attempt.completed_at,
  attempt.writing_started_at,
  attempt.writing_deadline_at,
  attempt.writing_submitted_at,
  session.listening_started_at,
  session.listening_deadline_at,
  now() AS server_now
FROM assessment.term_test_attempt AS attempt
LEFT JOIN assessment.term_test_exam_session AS session
  ON session.id = attempt.exam_session_id
WHERE attempt.id = $1::uuid
  AND attempt.test_slug = $2
  AND attempt.erp_course_class_id = $3::bigint
  AND attempt.erp_student_contact_id = $4::bigint
  AND attempt.listening_submitted_at IS NOT NULL
  AND attempt.superseded_at IS NULL;`;

export const findTermTestExamSessionAssetSql = `SELECT
  id::text AS exam_session_token,
  test_slug,
  listening_started_at,
  listening_deadline_at,
  listening_submitted_at,
  attempt_id::text AS attempt_token
FROM assessment.term_test_exam_session
WHERE id = $1::uuid
  AND test_slug = $2
  AND superseded_at IS NULL
  AND prepared_at >= now() - interval '8 hours';`;

export const startTermTestListeningSessionSql = `UPDATE assessment.term_test_exam_session
SET
  listening_started_at = coalesce(
    listening_started_at,
    now() - make_interval(secs => listening_resume_offset_seconds::double precision)
  ),
  listening_deadline_at = coalesce(
    listening_deadline_at,
    now() + make_interval(secs => ($3::double precision - listening_resume_offset_seconds::double precision))
  ),
  updated_at = now()
WHERE id = $1::uuid
  AND test_slug = $2
  AND attempt_mode <> 'answer_sheet'
  AND superseded_at IS NULL
  AND prepared_at >= now() - interval '8 hours'
RETURNING
  id::text AS exam_session_token,
  test_slug,
  student_name_snapshot AS student_name,
  listening_started_at,
  listening_deadline_at,
  listening_submitted_at,
  attempt_id::text AS attempt_token,
  now() AS server_now;`;

export const saveTermTestListeningDraftSql = `WITH updated AS (
  UPDATE assessment.term_test_exam_session
  SET
    listening_draft = $3::jsonb,
    listening_draft_revision = CASE
      WHEN $4::bigint IS NULL THEN listening_draft_revision + 1
      ELSE $4::bigint
    END,
    listening_draft_updated_at = now(),
    updated_at = now()
  WHERE id = $1::uuid
    AND test_slug = $2
    AND superseded_at IS NULL
    AND listening_started_at IS NOT NULL
    AND listening_submitted_at IS NULL
    AND now() <= listening_deadline_at
    AND ($4::bigint IS NULL OR $4::bigint > listening_draft_revision)
  RETURNING
    id::text AS exam_session_token,
    listening_deadline_at,
    listening_draft_updated_at,
    listening_draft_revision,
    listening_draft,
    true AS accepted,
    now() AS server_now
), stale AS (
  SELECT
    session.id::text AS exam_session_token,
    session.listening_deadline_at,
    session.listening_draft_updated_at,
    session.listening_draft_revision,
    session.listening_draft,
    false AS accepted,
    now() AS server_now
  FROM assessment.term_test_exam_session AS session
  WHERE session.id = $1::uuid
    AND session.test_slug = $2
    AND session.superseded_at IS NULL
    AND session.listening_started_at IS NOT NULL
    AND session.listening_submitted_at IS NULL
    AND now() <= session.listening_deadline_at
    AND $4::bigint IS NOT NULL
    AND $4::bigint <= session.listening_draft_revision
    AND NOT EXISTS (SELECT 1 FROM updated)
)
SELECT * FROM updated
UNION ALL
SELECT * FROM stale
LIMIT 1;`;

export const findTermTestListeningSubmissionSql = `SELECT
  session.id::text AS exam_session_token,
  session.test_slug,
  session.definition_version,
  session.erp_course_class_id::text AS class_id,
  session.class_name_snapshot AS class_name,
  session.erp_student_contact_id::text AS student_id,
  session.student_name_snapshot AS student_name,
  session.listening_started_at,
  session.listening_deadline_at,
  session.listening_draft,
  session.listening_draft_revision,
  session.listening_submitted_at,
  session.attempt_id::text AS attempt_token,
  now() > session.listening_deadline_at AS listening_timed_out,
  now() <= session.listening_deadline_at + interval '5 minutes' AS listening_submission_grace_active,
  definition.slug,
  definition.title AS test_title,
  definition.version,
  definition.listening_band_adjustment,
  definition.listening_definition,
  definition.reading_definition
FROM assessment.term_test_exam_session AS session
JOIN assessment.test_definition AS definition
  ON definition.slug = session.test_slug
 AND definition.version = session.definition_version
WHERE session.id = $1::uuid
  AND session.test_slug = $2
  AND session.attempt_mode <> 'answer_sheet'
  AND session.superseded_at IS NULL
  AND session.listening_started_at IS NOT NULL;`;

export const insertProtectedListeningAttemptSql = `WITH target_session AS (
  SELECT *
  FROM assessment.term_test_exam_session
  WHERE id = $2::uuid
    AND test_slug = $3
    AND superseded_at IS NULL
),
inserted AS (
  INSERT INTO assessment.term_test_attempt (
    client_submission_id,
    test_slug,
    definition_version,
    erp_course_class_id,
    class_name_snapshot,
    erp_student_contact_id,
    student_name_snapshot,
    exam_session_id,
    listening_answers,
    listening_result,
    listening_submitted_at
  )
  SELECT
    $1::uuid,
    session.test_slug,
    session.definition_version,
    session.erp_course_class_id,
    session.class_name_snapshot,
    session.erp_student_contact_id,
    session.student_name_snapshot,
    session.id,
    $4::jsonb,
    $5::jsonb,
    now()
  FROM target_session AS session
  ON CONFLICT DO NOTHING
  RETURNING *
),
resolved AS (
  SELECT * FROM inserted
  UNION ALL
  SELECT existing.*
  FROM assessment.term_test_attempt AS existing
  WHERE existing.test_slug = $3
    AND existing.client_submission_id = $1::uuid
    AND existing.exam_session_id = $2::uuid
    AND NOT EXISTS (SELECT 1 FROM inserted)
),
linked AS (
  UPDATE assessment.term_test_exam_session AS session
  SET
    attempt_id = resolved.id,
    listening_submitted_at = coalesce(session.listening_submitted_at, now()),
    updated_at = now()
  FROM resolved
  WHERE session.id = $2::uuid
    AND (session.attempt_id IS NULL OR session.attempt_id = resolved.id)
  RETURNING session.id
)
SELECT
  resolved.id::text AS attempt_token,
  resolved.exam_session_id::text AS exam_session_token,
  resolved.test_slug,
  resolved.erp_course_class_id::text AS class_id,
  resolved.class_name_snapshot AS class_name,
  resolved.erp_student_contact_id::text AS student_id,
  resolved.student_name_snapshot AS student_name,
  resolved.listening_result,
  resolved.listening_submitted_at,
  resolved.completed_at,
  resolved.combined_result
FROM resolved
JOIN linked ON linked.id = resolved.exam_session_id
LIMIT 1;`;

export const insertListeningAttemptSql = `WITH inserted AS (
  INSERT INTO assessment.term_test_attempt (
    client_submission_id,
    test_slug,
    definition_version,
    erp_course_class_id,
    class_name_snapshot,
    erp_student_contact_id,
    student_name_snapshot,
    listening_answers,
    listening_result,
    listening_submitted_at
  ) VALUES (
    $1::uuid, $2, $3::int, $4::bigint, $5, $6::bigint, $7,
    $8::jsonb, $9::jsonb, now()
  )
  ON CONFLICT DO NOTHING
  RETURNING *
),
resolved AS (
  SELECT inserted.*, 0 AS match_priority
  FROM inserted
  UNION ALL
  SELECT existing.*, 1 AS match_priority
  FROM assessment.term_test_attempt AS existing
  WHERE existing.test_slug = $2
    AND existing.client_submission_id = $1::uuid
    AND NOT EXISTS (SELECT 1 FROM inserted)
  UNION ALL
  SELECT existing.*, 2 AS match_priority
  FROM assessment.term_test_attempt AS existing
  WHERE existing.test_slug = $2
    AND existing.definition_version = $3::int
    AND existing.erp_course_class_id = $4::bigint
    AND existing.erp_student_contact_id = $6::bigint
    AND existing.completed_at IS NULL
    AND existing.superseded_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM inserted)
    AND NOT EXISTS (
      SELECT 1
      FROM assessment.term_test_attempt AS same_submission
      WHERE same_submission.test_slug = $2
        AND same_submission.client_submission_id = $1::uuid
    )
)
SELECT
  id::text AS attempt_token,
  test_slug,
  erp_course_class_id::text AS class_id,
  class_name_snapshot AS class_name,
  erp_student_contact_id::text AS student_id,
  student_name_snapshot AS student_name,
  listening_result,
  listening_submitted_at,
  reading_started_at,
  reading_deadline_at,
  reading_draft,
  reading_draft_revision,
  completed_at,
  combined_result,
  (match_priority = 2) AS resumed_active_attempt
FROM resolved
ORDER BY match_priority
LIMIT 1;`;

export const findAttemptForReadingSql = `SELECT
  attempt.id::text AS attempt_token,
  attempt.test_slug,
  attempt.definition_version,
  attempt.erp_course_class_id::text AS class_id,
  attempt.class_name_snapshot AS class_name,
  attempt.erp_student_contact_id::text AS student_id,
  attempt.student_name_snapshot AS student_name,
  attempt.listening_result,
  attempt.reading_started_at,
  attempt.reading_deadline_at,
  attempt.reading_draft,
  attempt.reading_draft_updated_at,
  attempt.reading_draft_revision,
  CASE
    WHEN attempt.reading_deadline_at IS NULL THEN false
    ELSE now() > attempt.reading_deadline_at
  END AS reading_timed_out,
  CASE
    WHEN attempt.reading_deadline_at IS NULL THEN false
    ELSE now() <= attempt.reading_deadline_at + interval '5 minutes'
  END AS reading_submission_grace_active,
  attempt.completed_at,
  attempt.combined_result,
  definition.slug,
  definition.title AS test_title,
  definition.version,
  definition.listening_band_adjustment,
  definition.listening_definition,
  definition.reading_definition
FROM assessment.term_test_attempt AS attempt
JOIN assessment.test_definition AS definition
  ON definition.slug = attempt.test_slug
 AND definition.version = attempt.definition_version
WHERE attempt.id = $1::uuid
  AND attempt.test_slug = $2
  AND attempt.attempt_mode <> 'answer_sheet'
  AND attempt.superseded_at IS NULL;`;

export const startReadingAttemptSql = `UPDATE assessment.term_test_attempt
SET
  reading_started_at = coalesce(reading_started_at, now()),
  reading_deadline_at = coalesce(reading_deadline_at, now() + make_interval(mins => $3::int)),
  updated_at = now()
WHERE id = $1::uuid
  AND test_slug = $2
  AND attempt_mode <> 'answer_sheet'
  AND completed_at IS NULL
  AND superseded_at IS NULL
RETURNING
  id::text AS attempt_token,
  reading_started_at,
  reading_deadline_at,
  reading_draft,
  reading_draft_revision,
  reading_submitted_at,
  completed_at,
  now() AS server_now;`;

export const saveReadingDraftSql = `WITH updated AS (
  UPDATE assessment.term_test_attempt
  SET
    reading_draft = $2::jsonb,
    reading_draft_revision = CASE
      WHEN $3::bigint IS NULL THEN reading_draft_revision + 1
      ELSE $3::bigint
    END,
    reading_draft_updated_at = now(),
    updated_at = now()
  WHERE id = $1::uuid
    AND completed_at IS NULL
    AND superseded_at IS NULL
    AND reading_started_at IS NOT NULL
    AND now() <= reading_deadline_at
    AND ($3::bigint IS NULL OR $3::bigint > reading_draft_revision)
  RETURNING
    id::text AS attempt_token,
    reading_deadline_at,
    reading_draft_updated_at,
    reading_draft_revision,
    reading_draft,
    true AS accepted,
    now() AS server_now
), stale AS (
  SELECT
    attempt.id::text AS attempt_token,
    attempt.reading_deadline_at,
    attempt.reading_draft_updated_at,
    attempt.reading_draft_revision,
    attempt.reading_draft,
    false AS accepted,
    now() AS server_now
  FROM assessment.term_test_attempt AS attempt
  WHERE attempt.id = $1::uuid
    AND attempt.completed_at IS NULL
    AND attempt.superseded_at IS NULL
    AND attempt.reading_started_at IS NOT NULL
    AND now() <= attempt.reading_deadline_at
    AND $3::bigint IS NOT NULL
    AND $3::bigint <= attempt.reading_draft_revision
    AND NOT EXISTS (SELECT 1 FROM updated)
)
SELECT * FROM updated
UNION ALL
SELECT * FROM stale
LIMIT 1;`;

export const completeReadingAttemptSql = `WITH updated AS (
  UPDATE assessment.term_test_attempt
  SET
    reading_answers = $2::jsonb,
    reading_result = $3::jsonb,
    combined_result = $4::jsonb,
    reading_submitted_at = now(),
    completed_at = now(),
    updated_at = now()
  WHERE id = $1::uuid
    AND completed_at IS NULL
    AND superseded_at IS NULL
  RETURNING *
),
resolved AS (
  SELECT * FROM updated
  UNION ALL
  SELECT existing.*
  FROM assessment.term_test_attempt AS existing
  WHERE existing.id = $1::uuid
    AND existing.completed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM updated)
)
SELECT id::text AS attempt_token, completed_at, combined_result
FROM resolved
LIMIT 1;`;

export const saveTermTestWritingSql = `WITH locked AS MATERIALIZED (
  SELECT * FROM assessment.term_test_attempt
  WHERE id=$1::uuid AND completed_at IS NOT NULL
  FOR UPDATE
), timed AS MATERIALIZED (
  SELECT locked.*, clock_timestamp() AS request_at FROM locked
), compared AS MATERIALIZED (
  SELECT timed.*,
    (writing_task_1=$2::text AND writing_task_2=$3::text) AS same_content,
    (writing_deadline_at IS NOT NULL AND request_at>writing_deadline_at) AS expired
  FROM timed
), decision AS MATERIALIZED (
  SELECT compared.*,
    CASE
      WHEN writing_submitted_at IS NOT NULL THEN same_content
      WHEN expired THEN $4::text='submit' AND same_content
      WHEN $4::text='start' THEN true
      WHEN $6::bigint IS NULL THEN false
      WHEN same_content THEN true
      ELSE writing_draft_revision=$6::bigint
    END AS accepted,
    CASE
      WHEN writing_submitted_at IS NOT NULL THEN 'already_submitted'
      WHEN expired THEN 'deadline_expired'
      WHEN $4::text='start' THEN 'started'
      WHEN $6::bigint IS NULL THEN 'client_update_required'
      WHEN NOT same_content AND writing_draft_revision<>$6::bigint THEN 'revision_conflict'
      WHEN same_content AND $4::text='draft' THEN 'already_saved'
      ELSE 'saved'
    END AS reason
  FROM compared
), updated AS (
  UPDATE assessment.term_test_attempt AS attempt SET
    writing_task_1=CASE WHEN decision.reason='saved' THEN $2::text ELSE attempt.writing_task_1 END,
    writing_task_2=CASE WHEN decision.reason='saved' THEN $3::text ELSE attempt.writing_task_2 END,
    writing_draft_revision=decision.writing_draft_revision +
      CASE WHEN decision.reason='saved' AND NOT decision.same_content THEN 1 ELSE 0 END,
    writing_started_at=coalesce(decision.writing_started_at, decision.request_at),
    writing_deadline_at=coalesce(decision.writing_deadline_at,
      decision.request_at + make_interval(mins=>$5::int)),
    writing_updated_at=decision.request_at,
    writing_submitted_at=CASE WHEN $4::text='submit' THEN decision.request_at ELSE NULL END,
    updated_at=decision.request_at
  FROM decision
  -- Chốt bài hết giờ độc lập với ACK nội dung: payload muộn khác canonical không được nhận.
  WHERE attempt.id=decision.id
    AND (decision.accepted OR (decision.expired AND $4::text='submit'))
    AND decision.writing_submitted_at IS NULL
    AND (
      decision.writing_started_at IS NULL
      OR (decision.reason='saved' AND NOT decision.same_content)
      OR $4::text='submit'
    )
  RETURNING attempt.*
), resolved AS (
  SELECT * FROM updated
  UNION ALL
  SELECT * FROM locked WHERE NOT EXISTS (SELECT 1 FROM updated)
)
SELECT resolved.id::text AS attempt_token, resolved.test_slug,
  resolved.writing_task_1, resolved.writing_task_2, resolved.writing_draft_revision,
  resolved.writing_started_at, resolved.writing_deadline_at,
  resolved.writing_updated_at, resolved.writing_submitted_at,
  decision.request_at AS server_now, decision.expired AS writing_timed_out,
  decision.accepted AS writing_accepted, decision.reason AS writing_reason
FROM resolved JOIN decision ON decision.id=resolved.id;`;

export const findTermTestAttemptSlugSql = `SELECT test_slug
FROM assessment.term_test_attempt
WHERE id = $1::uuid
  AND completed_at IS NOT NULL
LIMIT 1;`;

// Sự kiện lưu nháp phải nhận cả lượt chưa nộp; truy vấn kết quả vẫn giữ điều kiện riêng.
export const findTermTestClientEventAttemptSql = `SELECT test_slug
FROM assessment.term_test_attempt
WHERE id = $1::uuid AND superseded_at IS NULL
LIMIT 1;`;

export const fetchTermTestResultSql = `SELECT
  attempt.id::text AS attempt_token,
  attempt.test_slug,
  attempt.erp_course_class_id::text AS class_id,
  attempt.erp_student_contact_id::text AS student_id,
  attempt.class_name_snapshot AS class_name,
  attempt.student_name_snapshot AS student_name,
  attempt.exam_session_id::text AS exam_session_token,
  attempt.listening_submitted_at,
  attempt.reading_started_at,
  attempt.reading_deadline_at,
  attempt.reading_draft_updated_at,
  attempt.reading_submitted_at,
  attempt.completed_at,
  attempt.writing_task_1,
  attempt.writing_task_2,
  attempt.writing_draft_revision,
  attempt.writing_started_at,
  attempt.writing_deadline_at,
  attempt.writing_updated_at,
  attempt.writing_submitted_at,
  attempt.listening_result,
  attempt.combined_result,
  definition.title AS test_title,
  definition.version AS definition_version,
  now() AS server_now,
  CASE
    WHEN attempt.writing_deadline_at IS NULL THEN false
    ELSE now() > attempt.writing_deadline_at
  END AS writing_timed_out
FROM assessment.term_test_attempt AS attempt
JOIN assessment.test_definition AS definition
  ON definition.slug = attempt.test_slug
 AND definition.version = attempt.definition_version
WHERE attempt.id = $1::uuid
  AND attempt.listening_submitted_at IS NOT NULL;`;

export const fetchTermTestAttemptReviewSql = `SELECT
  attempt.id::text AS attempt_token,
  attempt.test_slug,
  attempt.student_name_snapshot AS student_name,
  attempt.listening_answers,
  attempt.reading_answers,
  attempt.writing_task_1,
  attempt.writing_task_2,
  attempt.completed_at,
  attempt.writing_submitted_at
FROM assessment.term_test_attempt AS attempt
WHERE attempt.id = $1::uuid
  AND attempt.completed_at IS NOT NULL
  AND (
    attempt.test_slug = 'mini-test-lesson-5'
    OR attempt.writing_submitted_at IS NOT NULL
  );`;

export const listTermTestTeacherOptionsSql = `WITH allowed_classes AS (
  SELECT
    course.erp_course_class_id::text AS class_id,
    course.erp_class_name_snapshot AS class_name,
    EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_access AS access
      WHERE access.reviewer_email = $1
        AND access.erp_course_class_id = course.erp_course_class_id
    ) AS is_assigned_teacher
  FROM mapping.classroom_course_mapping AS course
  WHERE ${teacherCanReadClass('$1', '$2', 'course.erp_course_class_id')}
),
active_tests AS (
  SELECT slug, title, version
  FROM assessment.test_definition
  WHERE is_active = true
)
SELECT jsonb_build_object(
  'classes', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', class_id,
        'name', class_name,
        'accessMode', CASE WHEN is_assigned_teacher THEN 'assigned_teacher' ELSE 'admin_override' END,
        'isAssignedTeacher', is_assigned_teacher
      )
      ORDER BY class_name
    )
    FROM allowed_classes
  ), '[]'::jsonb),
  'tests', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object('slug', slug, 'title', title, 'version', version)
      ORDER BY slug
    )
    FROM active_tests
  ), '[]'::jsonb)
) AS response;`;

export const listTermTestTeacherResultsSql = `WITH definition AS (
  SELECT slug, title, version
  FROM assessment.test_definition
  WHERE slug = $2
    AND is_active = true
),
target_classes AS (
  SELECT erp_course_class_id, erp_class_name_snapshot
  FROM mapping.classroom_course_mapping
  WHERE upper(trim(erp_class_name_snapshot)) = upper(trim($1))
),
authorized_classes AS (
  SELECT
    target.*,
    EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_access AS access
      WHERE access.reviewer_email = $3
        AND access.erp_course_class_id = target.erp_course_class_id
    ) AS is_assigned_teacher
  FROM target_classes AS target
  WHERE ${teacherCanReadClass('$3', '$4', 'target.erp_course_class_id')}
),
roster_mode AS (
  SELECT EXISTS (
    SELECT 1
    FROM assessment.term_test_roster AS roster
    JOIN authorized_classes AS target
      ON target.erp_course_class_id = roster.erp_course_class_id
    WHERE roster.test_slug = $2
  ) AS has_curated_roster
),
eligible_students AS (
  SELECT
    roster.erp_course_class_id,
    roster.erp_student_contact_id,
    roster.student_ref,
    roster.student_name_snapshot AS student_name,
    false AS temporary
  FROM assessment.term_test_roster AS roster
  JOIN authorized_classes AS target
    ON target.erp_course_class_id = roster.erp_course_class_id
  WHERE roster.test_slug = $2

  UNION ALL

  SELECT
    review.erp_course_class_id,
    review.erp_student_contact_id,
    review.public_id AS student_ref,
    review.erp_student_name_snapshot AS student_name,
    false AS temporary
  FROM mapping.student_mapping_review AS review
  JOIN authorized_classes AS target
    ON target.erp_course_class_id = review.erp_course_class_id
  CROSS JOIN roster_mode
  WHERE roster_mode.has_curated_roster = false
    AND review.status <> 'superseded'

  UNION ALL

  SELECT
    legacy.erp_course_class_id,
    legacy.erp_student_contact_id,
    review.public_id AS student_ref,
    legacy.student_name_snapshot AS student_name,
    false AS temporary
  FROM assessment.mini_test_result AS legacy
  JOIN authorized_classes AS target
    ON target.erp_course_class_id = legacy.erp_course_class_id
  JOIN mapping.student_mapping_review AS review
    ON review.erp_course_class_id = legacy.erp_course_class_id
   AND review.erp_student_contact_id = legacy.erp_student_contact_id
  WHERE legacy.test_slug = $2

  UNION ALL

  SELECT
    temporary_student.erp_course_class_id,
    -temporary_student.temporary_student_id AS erp_student_contact_id,
    temporary_student.student_ref,
    temporary_student.student_name_snapshot AS student_name,
    true AS temporary
  FROM assessment.term_test_temporary_student AS temporary_student
  JOIN authorized_classes AS target
    ON target.erp_course_class_id = temporary_student.erp_course_class_id
  WHERE temporary_student.test_slug = $2
    AND temporary_student.active = true
),
students AS (
  SELECT DISTINCT ON (erp_course_class_id, erp_student_contact_id)
    erp_course_class_id,
    erp_student_contact_id,
    student_ref,
    student_name,
    temporary
  FROM eligible_students
  ORDER BY erp_course_class_id, erp_student_contact_id, student_name
)
SELECT
  definition.slug AS test_slug,
  definition.title AS test_title,
  definition.version AS definition_version,
  (SELECT count(*)::int FROM target_classes) AS class_count,
  (SELECT count(*)::int FROM authorized_classes) AS authorized_class_count,
  (SELECT erp_course_class_id::text FROM authorized_classes LIMIT 1) AS class_id,
  (SELECT erp_class_name_snapshot FROM authorized_classes LIMIT 1) AS class_name,
  (SELECT is_assigned_teacher FROM authorized_classes LIMIT 1) AS is_assigned_teacher,
  (
    SELECT CASE WHEN is_assigned_teacher THEN 'assigned_teacher' ELSE 'admin_override' END
    FROM authorized_classes
    LIMIT 1
  ) AS access_mode,
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'ref', student.student_ref::text,
        'name', student.student_name,
        'temporary', student.temporary,
        'status', CASE
          WHEN attempt.completed_at IS NOT NULL AND attempt.combined_result IS NOT NULL THEN 'completed'
          WHEN attempt.id IS NOT NULL THEN 'incomplete'
          ELSE 'not_started'
        END,
        'completedAt', attempt.completed_at,
        'result', attempt.combined_result,
        'writing', jsonb_build_object(
          'status', CASE
            WHEN attempt.writing_submitted_at IS NULL THEN 'not_submitted'
            WHEN grading.final_status = 'ready' THEN 'ready'
            WHEN grading.task_1_status IN ('review_required', 'failed')
              OR grading.task_2_status IN ('review_required', 'failed') THEN 'review_required'
            ELSE 'processing'
          END,
          'task1State', CASE
            WHEN attempt.writing_submitted_at IS NULL THEN 'not_submitted'
            ELSE coalesce(grading.task_1_status, 'queued')
          END,
          'task2State', CASE
            WHEN attempt.writing_submitted_at IS NULL THEN 'not_submitted'
            ELSE coalesce(grading.task_2_status, 'queued')
          END,
          'task1Score', grading.task_1_score,
          'task2Score', grading.task_2_score,
          'writingScore', grading.writing_score,
          'updatedAt', grading.updated_at
        )
      )
      ORDER BY student.student_name
    )
    FROM students AS student
    LEFT JOIN LATERAL (
      SELECT
        candidate.id,
        candidate.completed_at,
        candidate.combined_result,
        candidate.writing_submitted_at,
        candidate.created_at
      FROM (
        SELECT
          stored.id,
          stored.completed_at,
          stored.combined_result,
          stored.writing_submitted_at,
          stored.created_at
        FROM assessment.term_test_attempt AS stored
        WHERE stored.test_slug = definition.slug
          AND stored.erp_course_class_id = student.erp_course_class_id
          AND stored.erp_student_contact_id = student.erp_student_contact_id

        UNION ALL

        SELECT
          legacy.id,
          legacy.updated_at AS completed_at,
          jsonb_set(
            jsonb_set(legacy.result, '{testTitle}', to_jsonb(definition.title), true),
            '{definitionVersion}',
            to_jsonb(definition.version),
            true
          ) AS combined_result,
          NULL::timestamptz AS writing_submitted_at,
          legacy.created_at
        FROM assessment.mini_test_result AS legacy
        WHERE legacy.test_slug = definition.slug
          AND legacy.erp_course_class_id = student.erp_course_class_id
          AND legacy.erp_student_contact_id = student.erp_student_contact_id
      ) AS candidate
      ORDER BY candidate.completed_at DESC NULLS LAST, candidate.created_at DESC
      LIMIT 1
    ) AS attempt ON true
    LEFT JOIN LATERAL (
      SELECT
        (SELECT final.status
         FROM assessment.term_test_writing_grading_final AS final
         WHERE final.attempt_id = attempt.id) AS final_status,
        (SELECT final.task_1_score
         FROM assessment.term_test_writing_grading_final AS final
         WHERE final.attempt_id = attempt.id) AS task_1_score,
        (SELECT final.task_2_score
         FROM assessment.term_test_writing_grading_final AS final
         WHERE final.attempt_id = attempt.id) AS task_2_score,
        (SELECT final.writing_score
         FROM assessment.term_test_writing_grading_final AS final
         WHERE final.attempt_id = attempt.id) AS writing_score,
        (SELECT run.status
         FROM assessment.term_test_writing_grading_run AS run
         WHERE run.attempt_id = attempt.id AND run.task_number = 1
         ORDER BY run.grading_version DESC
         LIMIT 1) AS task_1_status,
        (SELECT run.status
         FROM assessment.term_test_writing_grading_run AS run
         WHERE run.attempt_id = attempt.id AND run.task_number = 2
         ORDER BY run.grading_version DESC
         LIMIT 1) AS task_2_status,
        (SELECT max(run.updated_at)
         FROM assessment.term_test_writing_grading_run AS run
         WHERE run.attempt_id = attempt.id) AS updated_at
    ) AS grading ON true
  ), '[]'::jsonb) AS students
FROM definition;`;

export const fetchTermTestTeacherWritingDetailSql = `WITH definition AS (
  SELECT slug, title, version
  FROM assessment.test_definition
  WHERE slug = $2
    AND is_active = true
),
target_classes AS (
  SELECT erp_course_class_id, erp_class_name_snapshot
  FROM mapping.classroom_course_mapping
  WHERE upper(trim(erp_class_name_snapshot)) = upper(trim($1))
),
authorized_classes AS (
  SELECT target.*
  FROM target_classes AS target
  WHERE ${teacherCanReadClass('$3', '$4', 'target.erp_course_class_id')}
),
latest_attempt AS (
  SELECT attempt.*
  FROM assessment.term_test_attempt AS attempt
  JOIN authorized_classes AS target
    ON target.erp_course_class_id = attempt.erp_course_class_id
  WHERE attempt.test_slug = $2
    AND (
      EXISTS (
        SELECT 1
        FROM assessment.term_test_roster AS roster
        WHERE roster.test_slug = attempt.test_slug
          AND roster.erp_course_class_id = attempt.erp_course_class_id
          AND roster.erp_student_contact_id = attempt.erp_student_contact_id
          AND roster.student_ref = $5::uuid
      )
      OR EXISTS (
        SELECT 1
        FROM mapping.student_mapping_review AS review
        WHERE review.erp_course_class_id = attempt.erp_course_class_id
          AND review.erp_student_contact_id = attempt.erp_student_contact_id
          AND review.public_id = $5::uuid
          AND review.status <> 'superseded'
      )
      OR EXISTS (
        SELECT 1
        FROM assessment.term_test_temporary_student AS temporary
        WHERE temporary.test_slug = attempt.test_slug
          AND temporary.erp_course_class_id = attempt.erp_course_class_id
          AND -temporary.temporary_student_id = attempt.erp_student_contact_id
          AND temporary.student_ref = $5::uuid
          AND temporary.active = true
      )
    )
  ORDER BY attempt.completed_at DESC NULLS LAST, attempt.created_at DESC
  LIMIT 1
),
detail AS (
  SELECT
    attempt.student_name_snapshot AS student_name,
    jsonb_build_object(
      'taskNumber', run.task_number,
      'taskScore', run.task_score,
      'wordCount', run.word_count,
      'essay', coalesce(
        CASE WHEN run.task_number = 1 THEN attempt.writing_task_1 ELSE attempt.writing_task_2 END,
        ''
      ),
      'prompt', run.prompt_text,
      'promptImage', run.prompt_image_url,
      'criteria', coalesce(run.result_json->'criteria', '[]'::jsonb),
      'report', coalesce(run.result_json->>'report', ''),
      'completedAt', run.completed_at
    ) AS writing_detail
  FROM latest_attempt AS attempt
  JOIN assessment.term_test_writing_grading_final AS final
    ON final.attempt_id = attempt.id
   AND final.status = 'ready'
  JOIN assessment.term_test_writing_grading_run AS run
    ON run.id = CASE WHEN $6::smallint = 1 THEN final.task_1_run_id ELSE final.task_2_run_id END
   AND run.task_number = $6::smallint
   AND run.status = 'complete'
  WHERE attempt.writing_submitted_at IS NOT NULL
)
SELECT
  definition.slug AS test_slug,
  (SELECT count(*)::int FROM target_classes) AS class_count,
  (SELECT count(*)::int FROM authorized_classes) AS authorized_class_count,
  detail.student_name,
  detail.writing_detail
FROM definition
LEFT JOIN detail ON true;`;

export const fetchTermTestTeacherAttemptReviewSql = `WITH definition AS (
  SELECT slug, title, version
  FROM assessment.test_definition
  WHERE slug = $2
    AND is_active = true
),
target_classes AS (
  SELECT erp_course_class_id, erp_class_name_snapshot
  FROM mapping.classroom_course_mapping
  WHERE upper(trim(erp_class_name_snapshot)) = upper(trim($1))
),
authorized_classes AS (
  SELECT target.*
  FROM target_classes AS target
  WHERE ${teacherCanReadClass('$3', '$4', 'target.erp_course_class_id')}
),
latest_attempt AS (
  SELECT attempt.*
  FROM assessment.term_test_attempt AS attempt
  JOIN authorized_classes AS target
    ON target.erp_course_class_id = attempt.erp_course_class_id
  WHERE attempt.test_slug = $2
    AND attempt.completed_at IS NOT NULL
    AND (
      attempt.test_slug = 'mini-test-lesson-5'
      OR attempt.writing_submitted_at IS NOT NULL
    )
    AND (
      EXISTS (
        SELECT 1
        FROM assessment.term_test_roster AS roster
        WHERE roster.test_slug = attempt.test_slug
          AND roster.erp_course_class_id = attempt.erp_course_class_id
          AND roster.erp_student_contact_id = attempt.erp_student_contact_id
          AND roster.student_ref = $5::uuid
      )
      OR EXISTS (
        SELECT 1
        FROM mapping.student_mapping_review AS review
        WHERE review.erp_course_class_id = attempt.erp_course_class_id
          AND review.erp_student_contact_id = attempt.erp_student_contact_id
          AND review.public_id = $5::uuid
          AND review.status <> 'superseded'
      )
      OR EXISTS (
        SELECT 1
        FROM assessment.term_test_temporary_student AS temporary
        WHERE temporary.test_slug = attempt.test_slug
          AND temporary.erp_course_class_id = attempt.erp_course_class_id
          AND -temporary.temporary_student_id = attempt.erp_student_contact_id
          AND temporary.student_ref = $5::uuid
          AND temporary.active = true
      )
    )
  ORDER BY attempt.completed_at DESC NULLS LAST, attempt.created_at DESC
  LIMIT 1
)
SELECT
  definition.slug AS test_slug,
  (SELECT count(*)::int FROM target_classes) AS class_count,
  (SELECT count(*)::int FROM authorized_classes) AS authorized_class_count,
  attempt.student_name_snapshot AS student_name,
  attempt.listening_answers,
  attempt.reading_answers,
  attempt.writing_task_1,
  attempt.writing_task_2,
  attempt.completed_at,
  attempt.writing_submitted_at
FROM definition
LEFT JOIN latest_attempt AS attempt ON true;`;

export const findStudentForMiniTestSql = `SELECT
  student.erp_course_class_id::text AS class_id,
  student.class_name,
  student.erp_student_contact_id::text AS student_id,
  student.student_name
FROM assessment.mini_test_student_lookup AS student
WHERE upper(trim(student.class_name)) = upper(trim($1))
  AND lower(regexp_replace(trim(student.student_name), '\\s+', ' ', 'g')) =
      lower(regexp_replace(trim($2), '\\s+', ' ', 'g'));`;

export const upsertMiniTestResultSql = `INSERT INTO assessment.mini_test_result (
  source_submission_key,
  test_slug,
  erp_course_class_id,
  class_name_snapshot,
  erp_student_contact_id,
  student_name_snapshot,
  source_submitted_at,
  listening_correct,
  reading_correct,
  result
) VALUES (
  $1, $2, $3::bigint, $4, $5::bigint, $6, NULLIF($7, ''), $8::smallint, $9::smallint, $10::jsonb
)
ON CONFLICT (test_slug, source_submission_key) DO UPDATE SET
  erp_course_class_id = EXCLUDED.erp_course_class_id,
  class_name_snapshot = EXCLUDED.class_name_snapshot,
  erp_student_contact_id = EXCLUDED.erp_student_contact_id,
  student_name_snapshot = EXCLUDED.student_name_snapshot,
  source_submitted_at = EXCLUDED.source_submitted_at,
  listening_correct = EXCLUDED.listening_correct,
  reading_correct = EXCLUDED.reading_correct,
  result = EXCLUDED.result,
  updated_at = now()
RETURNING id::text AS result_id, updated_at;`;
