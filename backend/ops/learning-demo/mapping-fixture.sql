-- Kho demo chỉ có lớp/học viên giả; các bảng mapping tối thiểu phục vụ quyền giảng viên.
CREATE SCHEMA IF NOT EXISTS mapping;
CREATE TABLE IF NOT EXISTS mapping.classroom_course_mapping (
  erp_course_class_id BIGINT PRIMARY KEY,
  erp_class_name_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  approved_by TEXT,
  approved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS mapping.student_mapping_review (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  erp_course_class_id BIGINT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  erp_student_code TEXT,
  erp_student_name_snapshot TEXT NOT NULL,
  match_method TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'approved',
  reviewer_email TEXT,
  reviewer_note TEXT,
  decided_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (erp_course_class_id, erp_student_contact_id)
);
CREATE TABLE IF NOT EXISTS mapping.erp_class_membership_snapshot (
  erp_course_class_id BIGINT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  PRIMARY KEY (erp_course_class_id, erp_student_contact_id)
);
CREATE TABLE IF NOT EXISTS mapping.reviewer_class_access (
  reviewer_email TEXT NOT NULL,
  erp_course_class_id BIGINT NOT NULL,
  PRIMARY KEY (reviewer_email, erp_course_class_id)
);
CREATE TABLE IF NOT EXISTS mapping.reviewer_account (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS mapping.reviewer_class_assignment (
  reviewer_email TEXT NOT NULL,
  class_name TEXT NOT NULL
);
