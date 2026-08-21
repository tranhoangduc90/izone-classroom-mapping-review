BEGIN;

-- Dữ liệu nhận vào: hai nguồn Classroom của IC2146 đang gắn nhầm vào khóa tạm.
-- Việc chính: chuyển đúng nguồn và 18 kết quả sang khóa chuẩn của khóa 67.
-- Kết quả: giữ nguyên ID kết quả, trạng thái Portal và toàn bộ event đã liên kết.
-- Khi bất kỳ điều kiện an toàn nào không đúng, transaction dừng và không đổi dữ liệu.
SELECT pg_advisory_xact_lock(
  hashtextextended('writing-course67-phase2-canonical-2026-08-16', 0)
);

DO $$
DECLARE
  canonical_ok BOOLEAN;
  legacy_source_count INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM assessment.writing_test_definition
    WHERE test_key = 'course-67-phase-2'
      AND course_number = 67
      AND test_number = 2
      AND aggregation_mode = 'weighted_tasks'
      AND portal_test_name = 'Phase 2 Writing'
  ) INTO canonical_ok;
  IF NOT canonical_ok THEN
    RAISE EXCEPTION 'Khóa chuẩn course-67-phase-2 chưa đúng cấu hình';
  END IF;

  SELECT count(*) INTO legacy_source_count
  FROM assessment.writing_test_source
  WHERE test_key = 'course-56-term-2-weighted';
  IF legacy_source_count = 0
    AND NOT EXISTS (
      SELECT 1 FROM assessment.writing_test_result
      WHERE test_key = 'course-56-term-2-weighted'
    )
    AND (SELECT count(*) FROM assessment.writing_test_source
         WHERE test_key = 'course-67-phase-2'
           AND (classroom_course_id, classroom_coursework_id, component) IN (
             ('862713287326', '862713332833', 'task1'),
             ('862713287326', '872077785281', 'task2')
           )) = 2 THEN
    RETURN;
  END IF;
  IF legacy_source_count <> 2 THEN
    RAISE EXCEPTION 'Số nguồn legacy phải đúng bằng 2, thực tế %', legacy_source_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM assessment.writing_test_source
    WHERE test_key = 'course-56-term-2-weighted'
      AND (classroom_course_id, classroom_coursework_id, component) NOT IN (
        ('862713287326', '862713332833', 'task1'),
        ('862713287326', '872077785281', 'task2')
      )
  ) THEN
    RAISE EXCEPTION 'Nguồn legacy có dòng ngoài whitelist IC2146';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM assessment.writing_test_result
    WHERE test_key = 'course-56-term-2-weighted'
      AND erp_course_class_id <> 1131
  ) THEN
    RAISE EXCEPTION 'Khóa legacy có kết quả ngoài lớp IC2146/1131';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM assessment.writing_test_result old_result
    JOIN assessment.writing_test_result new_result
      ON new_result.erp_course_class_id = old_result.erp_course_class_id
     AND new_result.erp_student_contact_id = old_result.erp_student_contact_id
     AND new_result.test_key = 'course-67-phase-2'
    WHERE old_result.test_key = 'course-56-term-2-weighted'
  ) THEN
    RAISE EXCEPTION 'Có kết quả trùng giữa khóa legacy và khóa chuẩn';
  END IF;
END $$;

UPDATE assessment.writing_test_source
SET test_key = 'course-67-phase-2',
    lark_config_record_id = CASE component
      WHEN 'task1' THEN 'recvrTIEDXX4cQ'
      WHEN 'task2' THEN 'recvrTIF8ZbekA'
    END,
    updated_at = now()
WHERE test_key = 'course-56-term-2-weighted'
  AND (classroom_course_id, classroom_coursework_id, component) IN (
    ('862713287326', '862713332833', 'task1'),
    ('862713287326', '872077785281', 'task2')
  );

UPDATE assessment.writing_test_result
SET test_key = 'course-67-phase-2',
    updated_at = now()
WHERE test_key = 'course-56-term-2-weighted'
  AND erp_course_class_id = 1131;

UPDATE assessment.writing_test_definition
SET display_name = 'Khóa 67 - Phase 2 Writing',
    portal_test_name = 'Phase 2 Writing',
    aggregation_mode = 'weighted_tasks',
    wait_minutes = 720,
    enabled = true,
    updated_at = now()
WHERE test_key = 'course-67-phase-2';

UPDATE assessment.writing_test_definition
SET enabled = false,
    updated_at = now()
WHERE test_key = 'course-56-term-2-weighted';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM assessment.writing_test_source
    WHERE test_key = 'course-56-term-2-weighted'
  ) OR EXISTS (
    SELECT 1 FROM assessment.writing_test_result
    WHERE test_key = 'course-56-term-2-weighted'
  ) THEN
    RAISE EXCEPTION 'Vẫn còn dữ liệu dưới khóa legacy sau migration';
  END IF;

  IF (SELECT count(*) FROM assessment.writing_test_source
      WHERE test_key = 'course-67-phase-2'
        AND classroom_course_id = '862713287326'
        AND component IN ('task1', 'task2')) <> 2 THEN
    RAISE EXCEPTION 'Khóa chuẩn không có đủ hai nguồn IC2146';
  END IF;
END $$;

COMMIT;
