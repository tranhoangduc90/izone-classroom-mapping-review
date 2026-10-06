-- Bộ đệm ngữ cảnh thuộc DB K67, giữ kiểu/cột mà SQL hiện hành sử dụng.
-- Không sao chép bảng nghiệp vụ khác; dữ liệu được nhận qua API v1 sau khi kiểm scope.
CREATE SCHEMA mapping;
CREATE SCHEMA assessment;
CREATE TABLE mapping.classroom_course_mapping (
  erp_course_class_id bigint PRIMARY KEY,
  erp_class_name_snapshot text NOT NULL
);
CREATE TABLE mapping.student_mapping_review (
  public_id uuid PRIMARY KEY,
  erp_course_class_id bigint NOT NULL,
  erp_student_contact_id bigint NOT NULL,
  erp_student_name_snapshot text NOT NULL,
  status text NOT NULL
);
CREATE TABLE mapping.erp_class_membership_snapshot (
  erp_course_class_id bigint NOT NULL,
  erp_student_contact_id bigint NOT NULL,
  erp_student_name_snapshot text NOT NULL,
  source_state text NOT NULL DEFAULT 'active',
  PRIMARY KEY (erp_course_class_id, erp_student_contact_id)
);
CREATE TABLE mapping.reviewer_account (
  email text PRIMARY KEY,
  google_subject text UNIQUE,
  display_name text,
  role text NOT NULL DEFAULT 'teacher',
  status text NOT NULL DEFAULT 'active',
  can_access_all_classes boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mapping.reviewer_class_access (
  reviewer_email text NOT NULL REFERENCES mapping.reviewer_account(email),
  erp_course_class_id bigint NOT NULL,
  PRIMARY KEY (reviewer_email, erp_course_class_id)
);
CREATE TABLE mapping.reviewer_session (
  token_hash bytea PRIMARY KEY,
  reviewer_email text NOT NULL REFERENCES mapping.reviewer_account(email),
  google_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text
);
CREATE TABLE mapping.k67_context_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  api_version integer NOT NULL CHECK (api_version = 1),
  product_id text NOT NULL CHECK (product_id = 'PRODUCT-TERM-MINI-K67'),
  source_revision text NOT NULL,
  captured_at timestamptz NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
