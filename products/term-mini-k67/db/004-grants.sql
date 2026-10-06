-- Chỉ cấp quyền trong DB K67 mới; k67_app không có quyền tạo cấu trúc hoặc mở lớp.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO k67_app,k67_context_sync', current_database());
END;
$$;
GRANT USAGE ON SCHEMA assessment, mapping TO k67_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA assessment TO k67_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA assessment TO k67_app;
GRANT SELECT ON ALL TABLES IN SCHEMA mapping TO k67_app;
GRANT INSERT, UPDATE, DELETE ON mapping.reviewer_session TO k67_app;
GRANT UPDATE (google_subject, last_login_at, updated_at) ON mapping.reviewer_account TO k67_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA assessment FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assessment.reset_demo_term_test_student(text,text,uuid) TO k67_app;
REVOKE ALL ON SCHEMA collaboration FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA collaboration FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collaboration FROM PUBLIC;
GRANT USAGE ON SCHEMA mapping TO k67_context_sync;
GRANT SELECT, INSERT, UPDATE, DELETE ON mapping.classroom_course_mapping,
  mapping.student_mapping_review, mapping.erp_class_membership_snapshot,
  mapping.reviewer_account, mapping.reviewer_class_access, mapping.k67_context_state TO k67_context_sync;
-- Giữ tự ghi lịch sử cho các bảng tạo về sau trong DB riêng.
CREATE EVENT TRIGGER k67_collaboration_ddl ON ddl_command_end EXECUTE FUNCTION collaboration.record_ddl();
CREATE EVENT TRIGGER k67_collaboration_drop ON sql_drop EXECUTE FUNCTION collaboration.record_drop();
