-- Chỉ thực thi sau duyệt phát hành. Chạy bằng quản trị của đúng database.
-- Biến psql: database=mapping_db, assessment_schema=assessment_k56 (K56),
-- hoặc database=term_mini_k67, assessment_schema=assessment (K67).
-- reader_password truyền qua stdin/kênh bí mật, không đặt trong source/argv/log.
-- Role này mới hoàn toàn; nếu đã tồn tại, dừng và kiểm chủ sở hữu/quyền trước.
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE progress_log_test_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD :'reader_password';
GRANT CONNECT ON DATABASE :"database" TO progress_log_test_reader;
ALTER ROLE progress_log_test_reader IN DATABASE :"database" SET default_transaction_read_only=on;
ALTER ROLE progress_log_test_reader IN DATABASE :"database" SET statement_timeout='6s';
GRANT USAGE ON SCHEMA :"assessment_schema", mapping TO progress_log_test_reader;
GRANT SELECT ON :"assessment_schema".test_definition,
  :"assessment_schema".term_test_roster,
  :"assessment_schema".term_test_temporary_student,
  :"assessment_schema".term_test_attempt,
  :"assessment_schema".mini_test_result,
  :"assessment_schema".term_test_writing_grading_final,
  :"assessment_schema".term_test_writing_grading_run,
  mapping.student_mapping_review TO progress_log_test_reader;
COMMIT;
