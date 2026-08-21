-- Dữ liệu nhận vào: schema Writing Test hiện hành đã có biến thể Term Test 2 dạng điểm trực tiếp.
-- Việc chính: bổ sung một mã nội bộ riêng cho lớp dùng hai bài Task 1/Task 2.
-- Kết quả: cả hai cách tổ chức bài đều ghi vào cùng cột Portal `Term Test 2 Writing`.
-- Khi lỗi: toàn bộ migration rollback; biến thể điểm trực tiếp cũ không bị thay đổi.

BEGIN;

ALTER TABLE assessment.writing_test_definition
  DROP CONSTRAINT IF EXISTS writing_test_definition_course_number_test_number_key;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'assessment.writing_test_definition'::regclass
      AND conname = 'writing_test_definition_course_test_mode_key'
  ) THEN
    ALTER TABLE assessment.writing_test_definition
      ADD CONSTRAINT writing_test_definition_course_test_mode_key
      UNIQUE (course_number, test_number, aggregation_mode);
  END IF;
END
$constraints$;

INSERT INTO assessment.writing_test_definition (
  test_key, course_number, test_number, display_name, portal_test_name,
  aggregation_mode, wait_minutes, enabled
) VALUES (
  'course-56-term-2-weighted', 56, 2,
  'Khóa 56 - Term Test 2 Writing - hai Task',
  'Term Test 2 Writing', 'weighted_tasks', 720, false
)
ON CONFLICT (test_key) DO UPDATE SET
  course_number = EXCLUDED.course_number,
  test_number = EXCLUDED.test_number,
  display_name = EXCLUDED.display_name,
  portal_test_name = EXCLUDED.portal_test_name,
  aggregation_mode = EXCLUDED.aggregation_mode,
  wait_minutes = EXCLUDED.wait_minutes,
  updated_at = now();

ALTER TABLE assessment.writing_test_source
  DROP CONSTRAINT IF EXISTS writing_test_source_check;

ALTER TABLE assessment.writing_test_source
  DROP CONSTRAINT IF EXISTS writing_test_source_component_test_key_check;

ALTER TABLE assessment.writing_test_source
  ADD CONSTRAINT writing_test_source_component_test_key_check CHECK (
    (
      component = 'direct'
      AND test_key NOT IN ('course-56-term-2-weighted', 'course-67-phase-2')
    )
    OR
    (
      component IN ('task1', 'task2')
      AND test_key IN ('course-56-term-2-weighted', 'course-67-phase-2')
    )
  );

COMMIT;
