-- Chỉ chạy sau duyệt trong mapping_db. View mới chỉ đọc; không đổi consumer hiện hành.
DO $$ BEGIN
 IF current_database()<>'mapping_db' THEN RAISE EXCEPTION 'Run owner-source view only in mapping_db'; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS listening_owner_api_v1;
REVOKE ALL ON SCHEMA listening_owner_api_v1 FROM PUBLIC;
CREATE OR REPLACE VIEW listening_owner_api_v1.owner AS
 SELECT m.erp_course_class_id::text AS class_id,m.public_id AS student_ref,
 c.classroom_course_id::text AS course_id,m.classroom_user_id::text AS google_user_id
 FROM mapping.student_mapping_review m
 JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id=m.erp_course_class_id AND c.status='approved'
 WHERE m.status='approved' AND m.classroom_user_id IS NOT NULL AND m.classroom_course_id=c.classroom_course_id
 AND m.erp_course_class_id IN (-8062028,1124,1131,1135,1157,1166,1187,1199,1226,1250,1293)
 AND EXISTS(SELECT 1 FROM mapping.erp_class_membership_snapshot e
  WHERE e.erp_course_class_id=m.erp_course_class_id AND e.erp_student_contact_id=m.erp_student_contact_id
  AND e.source_state='active' AND lower(trim(coalesce(e.registration_status,''))) NOT IN ('dropped','on_hold'));
-- Tạo role listening_owner_reader riêng, không superuser, không quyền ghi/bảng gốc.
GRANT USAGE ON SCHEMA listening_owner_api_v1 TO listening_owner_reader;
GRANT SELECT ON listening_owner_api_v1.owner TO listening_owner_reader;
