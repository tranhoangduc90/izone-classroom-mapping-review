-- Namespace/API nguồn mới; không sửa bảng hay runtime consumer hiện hành.
-- Allowlist giữ đủ lớp đã có roster/lượt thi; role chỉ đọc năm view, không bảng gốc.
CREATE SCHEMA k67_context_api_v1;
REVOKE ALL ON SCHEMA k67_context_api_v1 FROM PUBLIC;
CREATE TABLE k67_context_api_v1.class_scope (class_id bigint PRIMARY KEY);
INSERT INTO k67_context_api_v1.class_scope VALUES
  (-8062028),(1124),(1131),(1135),(1157),(1166),(1187),(1199),(1226),(1250),(1293);
CREATE VIEW k67_context_api_v1.classes WITH (security_barrier=true) AS
  SELECT c.erp_course_class_id::text AS erp_course_class_id,c.erp_class_name_snapshot
  FROM mapping.classroom_course_mapping c
  JOIN k67_context_api_v1.class_scope s ON s.class_id=c.erp_course_class_id;
CREATE VIEW k67_context_api_v1.students WITH (security_barrier=true) AS
  SELECT r.public_id::text AS public_id,r.erp_course_class_id::text AS erp_course_class_id,
    r.erp_student_contact_id::text AS erp_student_contact_id,r.erp_student_name_snapshot,r.status::text AS status
  FROM mapping.student_mapping_review r
  JOIN k67_context_api_v1.class_scope s ON s.class_id=r.erp_course_class_id;
CREATE VIEW k67_context_api_v1.memberships WITH (security_barrier=true) AS
  SELECT r.erp_course_class_id::text AS erp_course_class_id,r.erp_student_contact_id::text AS erp_student_contact_id,
    r.erp_student_name_snapshot,r.source_state::text AS source_state
  FROM mapping.erp_class_membership_snapshot r
  JOIN k67_context_api_v1.class_scope s ON s.class_id=r.erp_course_class_id;
CREATE VIEW k67_context_api_v1.accounts WITH (security_barrier=true) AS
  SELECT lower(a.email) AS email,a.google_subject,a.display_name,a.role::text AS role,
    CASE WHEN a.status='active' THEN 'active' ELSE 'disabled' END AS status,a.can_access_all_classes
  FROM mapping.reviewer_account a WHERE a.role='admin' OR a.can_access_all_classes
    OR EXISTS (SELECT 1 FROM mapping.reviewer_class_access r
       JOIN k67_context_api_v1.class_scope s ON s.class_id=r.erp_course_class_id WHERE r.reviewer_email=a.email);
CREATE VIEW k67_context_api_v1.access WITH (security_barrier=true) AS
  SELECT lower(r.reviewer_email) AS reviewer_email,r.erp_course_class_id::text AS erp_course_class_id
  FROM mapping.reviewer_class_access r
  JOIN k67_context_api_v1.class_scope s ON s.class_id=r.erp_course_class_id
  JOIN k67_context_api_v1.accounts a ON a.email=lower(r.reviewer_email);
GRANT CONNECT ON DATABASE mapping_db TO k67_context_reader;
GRANT USAGE ON SCHEMA k67_context_api_v1 TO k67_context_reader;
GRANT SELECT ON k67_context_api_v1.classes,k67_context_api_v1.students,
  k67_context_api_v1.memberships,k67_context_api_v1.accounts,k67_context_api_v1.access TO k67_context_reader;
ALTER ROLE k67_context_reader SET default_transaction_read_only=on;
ALTER ROLE k67_context_reader SET statement_timeout='5s';
ALTER ROLE k67_context_reader SET idle_in_transaction_session_timeout='5s';
