-- Dữ liệu nhận vào: mã lớp demo, mã bài thi và UUID công khai của một học viên demo.
-- Việc chính: xác minh đúng roster CODEXDEMO806 rồi xóa toàn bộ phiên thi và bài làm của riêng học viên đó.
-- Kết quả: học viên vẫn còn trong danh sách lớp nhưng có thể bắt đầu một lượt Term Test 2 hoàn toàn mới.
-- Khi lỗi: transaction rollback; lớp thật và học viên ngoài roster demo không thể bị xóa.

BEGIN;

CREATE OR REPLACE FUNCTION assessment.reset_demo_term_test_student(
  p_class_code TEXT,
  p_test_slug TEXT,
  p_student_ref UUID
)
RETURNS TABLE (deleted_attempts INTEGER, deleted_sessions INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, assessment, mapping
AS $function$
DECLARE
  target_class_id BIGINT;
  target_student_id BIGINT;
  class_count INTEGER;
BEGIN
  IF upper(trim(p_class_code)) <> 'CODEXDEMO806' OR trim(p_test_slug) <> 'term-test-2' THEN
    RAISE EXCEPTION 'Chỉ được reset dữ liệu Term Test 2 của lớp CODEXDEMO806.'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::INTEGER, min(course.erp_course_class_id)
  INTO class_count, target_class_id
  FROM mapping.classroom_course_mapping AS course
  WHERE upper(trim(course.erp_class_name_snapshot)) = 'CODEXDEMO806';

  IF class_count <> 1 OR target_class_id IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy duy nhất một lớp CODEXDEMO806.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT roster.erp_student_contact_id
  INTO target_student_id
  FROM assessment.term_test_roster AS roster
  WHERE roster.test_slug = 'term-test-2'
    AND roster.erp_course_class_id = target_class_id
    AND roster.student_ref = p_student_ref;

  IF target_student_id IS NULL THEN
    RAISE EXCEPTION 'Học viên không thuộc roster Term Test 2 của CODEXDEMO806.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Xóa bảng tổng hợp trước vì bảng này còn tham chiếu hai lượt chấm Task 1/Task 2.
  DELETE FROM assessment.term_test_writing_grading_final AS final
  USING assessment.term_test_attempt AS attempt
  WHERE final.attempt_id = attempt.id
    AND attempt.test_slug = 'term-test-2'
    AND attempt.erp_course_class_id = target_class_id
    AND attempt.erp_student_contact_id = target_student_id;

  -- Gỡ hai chiều liên kết giữa phiên thi và bài làm trước khi xóa.
  UPDATE assessment.term_test_attempt
  SET exam_session_id = NULL
  WHERE test_slug = 'term-test-2'
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;

  UPDATE assessment.term_test_exam_session
  SET attempt_id = NULL
  WHERE test_slug = 'term-test-2'
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;

  DELETE FROM assessment.term_test_attempt
  WHERE test_slug = 'term-test-2'
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;
  GET DIAGNOSTICS deleted_attempts = ROW_COUNT;

  DELETE FROM assessment.term_test_exam_session
  WHERE test_slug = 'term-test-2'
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;
  GET DIAGNOSTICS deleted_sessions = ROW_COUNT;

  RETURN NEXT;
END
$function$;

REVOKE ALL ON FUNCTION assessment.reset_demo_term_test_student(TEXT, TEXT, UUID) FROM PUBLIC;

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_review_api') THEN
    GRANT EXECUTE ON FUNCTION assessment.reset_demo_term_test_student(TEXT, TEXT, UUID)
      TO mapping_review_api;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_app') THEN
    GRANT EXECUTE ON FUNCTION assessment.reset_demo_term_test_student(TEXT, TEXT, UUID)
      TO mapping_app;
  END IF;
END
$permissions$;

COMMIT;
