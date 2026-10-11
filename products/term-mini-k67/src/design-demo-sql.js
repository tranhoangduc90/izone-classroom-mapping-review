// Demo mở cho mọi Google đã xác minh, cố định IC2200/Term Test 2; không tạo phiên thi.

export const demoSourceSql = `WITH target AS (
  SELECT erp_course_class_id FROM mapping.classroom_course_mapping
  WHERE upper(trim(erp_class_name_snapshot)) = $1
), permitted AS (
  SELECT * FROM target WHERE $1 = 'IC2200' AND $2 = 'term-test-2' AND length($3::text) > 0
    AND $4::jsonb->>'source' = 'demo_google'
    AND length($4::jsonb->>'googleSubject') > 0
), definition AS (
  SELECT slug AS test_slug, title AS test_title, version AS definition_version,
    listening_definition, reading_definition, listening_band_adjustment
  FROM assessment.test_definition WHERE slug = $2 AND is_active
), attempts AS (
  SELECT a.* FROM assessment.term_test_attempt a
  JOIN permitted p ON p.erp_course_class_id = a.erp_course_class_id
  WHERE a.test_slug = $2 AND a.superseded_at IS NULL
    AND a.completed_at IS NOT NULL AND a.writing_submitted_at IS NOT NULL
), selected AS (
  SELECT * FROM attempts WHERE id = $5::uuid
)
SELECT d.*,
  (SELECT count(*)::int FROM target) AS class_count,
  (SELECT count(*)::int FROM permitted) AS authorized_class_count,
  CASE WHEN $5::uuid IS NULL THEN coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id', id, 'name', student_name_snapshot, 'submittedAt', writing_submitted_at,
    'definitionVersion', definition_version
  ) ORDER BY student_name_snapshot, writing_submitted_at DESC) FROM attempts), '[]'::jsonb) END AS attempts,
  (SELECT jsonb_build_object(
    'id', a.id, 'definitionVersion', a.definition_version, 'name', a.student_name_snapshot,
    'submittedAt', a.writing_submitted_at,
    'listening', a.listening_answers, 'reading', a.reading_answers,
    'task1', a.writing_task_1, 'task2', a.writing_task_2, 'result', a.combined_result,
    'grading', (SELECT jsonb_build_object(
      'ready', f.status = 'ready', 'status', f.status, 'gradingVersion', f.grading_version,
      'writingScore', f.writing_score, 'task1Score', f.task_1_score, 'task2Score', f.task_2_score,
      'tasks', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'taskNumber', r.task_number, 'taskScore', r.task_score, 'wordCount', r.word_count,
        'essay', r.essay_text, 'prompt', r.prompt_text,
        'criteria', r.result_json->'criteria', 'report', r.result_json->>'report',
        'completedAt', r.completed_at
      ) ORDER BY r.task_number) FROM assessment.term_test_writing_grading_run r
      WHERE r.attempt_id = a.id AND r.grading_version = f.grading_version
        AND r.id = CASE WHEN r.task_number = 1 THEN f.task_1_run_id ELSE f.task_2_run_id END
        AND r.task_number IN (1,2) AND r.status = 'complete'
        AND r.essay_text = CASE WHEN r.task_number = 1 THEN a.writing_task_1 ELSE a.writing_task_2 END
      ), '[]'::jsonb)
    ) FROM assessment.term_test_writing_grading_final f WHERE f.attempt_id = a.id)
  ) FROM selected a) AS snapshot
FROM definition d;`;
