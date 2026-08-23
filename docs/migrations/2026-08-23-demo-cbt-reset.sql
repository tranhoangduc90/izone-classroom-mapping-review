-- Dữ liệu nhận vào: mã lớp demo, mã bài thi CBT và UUID công khai của một học viên demo.
-- Việc chính: xác minh đúng danh sách CODEXDEMO806 rồi xóa phiên thi, bài làm và kết quả Mini cũ của riêng học viên đó.
-- Kết quả: học viên vẫn còn trong danh sách lớp nhưng có thể bắt đầu lại đúng bài đã chọn.
-- Khi lỗi: transaction rollback; lớp thật, bài ngoài danh sách và học viên ngoài roster demo không thể bị xóa.

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
  has_curated_roster BOOLEAN := false;
  deleted_term_attempts INTEGER := 0;
  deleted_mini_results INTEGER := 0;
BEGIN
  IF upper(trim(p_class_code)) <> 'CODEXDEMO806'
     OR trim(p_test_slug) NOT IN ('term-test-1', 'term-test-2', 'mini-test-lesson-5') THEN
    RAISE EXCEPTION 'Chỉ được reset bài thi CBT của lớp CODEXDEMO806.'
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

  SELECT EXISTS (
    SELECT 1
    FROM assessment.term_test_roster AS roster
    WHERE roster.test_slug = trim(p_test_slug)
      AND roster.erp_course_class_id = target_class_id
  )
  INTO has_curated_roster;

  IF has_curated_roster THEN
    SELECT roster.erp_student_contact_id
    INTO target_student_id
    FROM assessment.term_test_roster AS roster
    WHERE roster.test_slug = trim(p_test_slug)
      AND roster.erp_course_class_id = target_class_id
      AND roster.student_ref = p_student_ref;
  ELSE
    SELECT review.erp_student_contact_id
    INTO target_student_id
    FROM mapping.student_mapping_review AS review
    WHERE review.erp_course_class_id = target_class_id
      AND review.public_id = p_student_ref
      AND review.status <> 'superseded';
  END IF;

  IF target_student_id IS NULL THEN
    RAISE EXCEPTION 'Học viên không thuộc danh sách của bài demo đã chọn.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Xóa bảng tổng hợp trước vì bảng này còn tham chiếu lượt chấm Writing.
  DELETE FROM assessment.term_test_writing_grading_final AS final
  USING assessment.term_test_attempt AS attempt
  WHERE final.attempt_id = attempt.id
    AND attempt.test_slug = trim(p_test_slug)
    AND attempt.erp_course_class_id = target_class_id
    AND attempt.erp_student_contact_id = target_student_id;

  -- Gỡ hai chiều liên kết giữa phiên thi và bài làm trước khi xóa.
  UPDATE assessment.term_test_attempt
  SET exam_session_id = NULL
  WHERE test_slug = trim(p_test_slug)
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;

  UPDATE assessment.term_test_exam_session
  SET attempt_id = NULL
  WHERE test_slug = trim(p_test_slug)
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;

  DELETE FROM assessment.term_test_attempt
  WHERE test_slug = trim(p_test_slug)
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;
  GET DIAGNOSTICS deleted_term_attempts = ROW_COUNT;

  DELETE FROM assessment.term_test_exam_session
  WHERE test_slug = trim(p_test_slug)
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;
  GET DIAGNOSTICS deleted_sessions = ROW_COUNT;

  -- Mini Test bản answer sheet cũ lưu ở bảng riêng; xóa cùng học viên để nút Reset có hành vi thống nhất.
  IF trim(p_test_slug) = 'mini-test-lesson-5' THEN
    DELETE FROM assessment.mini_test_result
    WHERE test_slug = trim(p_test_slug)
      AND erp_course_class_id = target_class_id
      AND erp_student_contact_id = target_student_id;
    GET DIAGNOSTICS deleted_mini_results = ROW_COUNT;
  END IF;

  deleted_attempts := deleted_term_attempts + deleted_mini_results;
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
