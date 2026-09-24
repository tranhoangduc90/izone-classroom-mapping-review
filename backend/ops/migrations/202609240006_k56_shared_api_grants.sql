-- Dữ liệu vào: role k56_shared_api đã được tạo riêng, chưa có mật khẩu trong Git.
-- Việc chính: cấp đúng quyền API cần trên mapping chung và bài thi K56.
-- Kết quả: K56 đọc/ghi bài thi của mình, không được cấp USAGE schema K67.
-- Khi lỗi: giao dịch rollback; không đổi grant đang có của API K67.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $check_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'k56_shared_api') THEN
    RAISE EXCEPTION 'K56_SHARED_ROLE_MISSING';
  END IF;
END
$check_role$;

GRANT USAGE ON SCHEMA mapping, assessment_k56 TO k56_shared_api;

GRANT SELECT ON mapping.classroom_course_mapping,
  mapping.classroom_roster_snapshot,
  mapping.erp_class_membership_snapshot,
  mapping.lark_replica_run,
  mapping.reviewer_class_access,
  mapping.reviewer_class_assignment,
  mapping.sync_run TO k56_shared_api;
GRANT SELECT, INSERT ON mapping.mapping_decision_event TO k56_shared_api;
GRANT SELECT, UPDATE ON mapping.reviewer_account,
  mapping.student_mapping_review TO k56_shared_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON mapping.reviewer_session TO k56_shared_api;
GRANT SELECT, INSERT, UPDATE ON mapping.student_identity_mapping TO k56_shared_api;

GRANT SELECT ON assessment_k56.test_definition,
  assessment_k56.term_test_roster,
  assessment_k56.term_test_class_access,
  assessment_k56.mini_test_student_lookup TO k56_shared_api;
GRANT SELECT, INSERT, UPDATE ON assessment_k56.mini_test_result,
  assessment_k56.term_test_attempt,
  assessment_k56.term_test_exam_session,
  assessment_k56.term_test_portal_sync_job,
  assessment_k56.term_test_portal_sync_state,
  assessment_k56.term_test_temporary_student TO k56_shared_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  assessment_k56.term_test_writing_grading_component,
  assessment_k56.term_test_writing_grading_criterion,
  assessment_k56.term_test_writing_grading_final,
  assessment_k56.term_test_writing_grading_job,
  assessment_k56.term_test_writing_grading_run TO k56_shared_api;
GRANT USAGE ON SEQUENCE
  assessment_k56.term_test_temporary_student_temporary_student_id_seq
  TO k56_shared_api;

REVOKE EXECUTE ON FUNCTION
  assessment_k56.reset_demo_term_test_student(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  assessment_k56.reset_demo_term_test_student(text, text, uuid) TO k56_shared_api;

COMMIT;
