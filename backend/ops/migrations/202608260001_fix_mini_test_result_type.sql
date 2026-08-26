-- Dữ liệu nhận vào: kết quả bài thi web trong term_test_attempt, gồm cả Term Test và Mini Test.
-- Việc chính: phân loại kết quả theo test_slug thay vì mặc định mọi attempt là Term Test.
-- Kết quả: Mini Test dùng chung luồng thi web vẫn hiện đúng nhãn trên bản sao Lark.
-- Khi lỗi: migration runner rollback toàn bộ; view và dữ liệu nguồn không bị sửa dở dang.

CREATE OR REPLACE VIEW mapping.lark_export_results_2026
WITH (security_barrier = true) AS
SELECT
  'term:' || attempt.id::text AS source_key,
  ARRAY[attempt.erp_course_class_id]::bigint[] AS scope_class_ids,
  attempt.updated_at AS source_updated_at,
  'Đang có trong nguồn'::text AS source_status,
  jsonb_strip_nulls(jsonb_build_object(
    'Loại kết quả', CASE
      WHEN attempt.test_slug LIKE 'mini-test-%' THEN 'Mini Test'
      ELSE 'Term Test'
    END,
    'Mã bài kiểm tra', attempt.test_slug,
    'ERP Class ID', attempt.erp_course_class_id::text,
    'Tên lớp', attempt.class_name_snapshot,
    'ERP Student ID', attempt.erp_student_contact_id::text,
    'Tên học viên', attempt.student_name_snapshot,
    'Kỹ năng', 'Listening + Reading',
    'Điểm nghe', CASE
      WHEN coalesce(
        attempt.combined_result #> '{listening,band}',
        attempt.listening_result -> 'band'
      ) #>> '{}' = '<2.5' THEN NULL
      ELSE coalesce(
        attempt.combined_result #> '{listening,band}',
        attempt.listening_result -> 'band'
      )
    END,
    'Điểm đọc', CASE
      WHEN coalesce(
        attempt.combined_result #> '{reading,band}',
        attempt.reading_result -> 'band'
      ) #>> '{}' = '<2.5' THEN NULL
      ELSE coalesce(
        attempt.combined_result #> '{reading,band}',
        attempt.reading_result -> 'band'
      )
    END,
    'Điểm tổng hợp', attempt.combined_result #> '{summary,averageBand}',
    'Số câu đúng', attempt.combined_result #> '{summary,totalCorrect}',
    'Tổng số câu', attempt.combined_result #> '{summary,totalQuestions}',
    'Trạng thái kết quả', CASE WHEN attempt.completed_at IS NULL
      THEN 'Chưa hoàn thành' ELSE 'Đã hoàn thành' END,
    'Hoàn thành lúc', attempt.completed_at
  )) AS payload
FROM assessment.term_test_attempt AS attempt
WHERE attempt.created_at >= timestamptz '2026-01-01 00:00:00+07'
  AND attempt.created_at < timestamptz '2027-01-01 00:00:00+07'

UNION ALL

SELECT
  'mini:' || result.id::text AS source_key,
  ARRAY[result.erp_course_class_id]::bigint[] AS scope_class_ids,
  result.updated_at AS source_updated_at,
  'Đang có trong nguồn'::text AS source_status,
  jsonb_strip_nulls(jsonb_build_object(
    'Loại kết quả', 'Mini Test',
    'Mã bài kiểm tra', result.test_slug,
    'ERP Class ID', result.erp_course_class_id::text,
    'Tên lớp', result.class_name_snapshot,
    'ERP Student ID', result.erp_student_contact_id::text,
    'Tên học viên', result.student_name_snapshot,
    'Kỹ năng', 'Listening + Reading',
    'Điểm nghe', CASE
      WHEN result.result #>> '{listening,band}' = '<2.5' THEN NULL
      ELSE result.result #> '{listening,band}'
    END,
    'Điểm đọc', CASE
      WHEN result.result #>> '{reading,band}' = '<2.5' THEN NULL
      ELSE result.result #> '{reading,band}'
    END,
    'Điểm tổng hợp', result.result #> '{summary,averageBand}',
    'Số câu đúng', result.result #> '{summary,totalCorrect}',
    'Tổng số câu', result.result #> '{summary,totalQuestions}',
    'Trạng thái kết quả', 'Đã hoàn thành',
    'Hoàn thành lúc', result.updated_at
  )) AS payload
FROM assessment.mini_test_result AS result
WHERE result.created_at >= timestamptz '2026-01-01 00:00:00+07'
  AND result.created_at < timestamptz '2027-01-01 00:00:00+07'

UNION ALL

SELECT
  'writing:' || result.id::text AS source_key,
  ARRAY[result.erp_course_class_id]::bigint[] AS scope_class_ids,
  result.updated_at AS source_updated_at,
  'Đang có trong nguồn'::text AS source_status,
  jsonb_strip_nulls(jsonb_build_object(
    'Loại kết quả', 'Writing',
    'Mã bài kiểm tra', result.test_key,
    'ERP Class ID', result.erp_course_class_id::text,
    'Tên lớp', result.class_name_snapshot,
    'ERP Student ID', result.erp_student_contact_id::text,
    'Tên học viên', result.student_name_snapshot,
    'Kỹ năng', concat_ws(' + ',
      CASE WHEN result.direct_score IS NOT NULL THEN 'Điểm trực tiếp' END,
      CASE WHEN result.task1_score IS NOT NULL THEN 'Task 1' END,
      CASE WHEN result.task2_score IS NOT NULL THEN 'Task 2' END
    ),
    'Điểm Writing', coalesce(result.writing_overall, result.direct_score),
    'Điểm tổng hợp', result.writing_overall,
    'Trạng thái kết quả', result.status,
    'Hoàn thành lúc', coalesce(result.portal_synced_at, result.updated_at)
  )) AS payload
FROM assessment.writing_test_result AS result
WHERE result.created_at >= timestamptz '2026-01-01 00:00:00+07'
  AND result.created_at < timestamptz '2027-01-01 00:00:00+07';
