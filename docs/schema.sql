-- Cấu trúc PostgreSQL đang dùng cho dữ liệu mapping.
-- Repo chỉ lưu cấu trúc; không chứa credential hoặc dữ liệu học viên thật.

CREATE SCHEMA IF NOT EXISTS mapping;

CREATE TABLE mapping.sync_run (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  class_names TEXT[] NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  row_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE mapping.classroom_course_mapping (
  id BIGSERIAL PRIMARY KEY,
  erp_course_class_id BIGINT NOT NULL UNIQUE,
  erp_class_name_snapshot TEXT NOT NULL,
  classroom_course_id TEXT UNIQUE,
  classroom_course_name_snapshot TEXT,
  classroom_section_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'inactive', 'conflict')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mapping.classroom_roster_snapshot (
  id BIGSERIAL PRIMARY KEY,
  classroom_course_id TEXT NOT NULL,
  classroom_user_id TEXT NOT NULL,
  classroom_name_snapshot TEXT,
  classroom_email_snapshot TEXT,
  roster_state TEXT NOT NULL DEFAULT 'active'
    CHECK (roster_state IN ('active', 'removed', 'unknown')),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id BIGINT REFERENCES mapping.sync_run(id),
  UNIQUE (classroom_course_id, classroom_user_id)
);

CREATE INDEX idx_roster_course
  ON mapping.classroom_roster_snapshot (classroom_course_id);

CREATE TABLE mapping.class_monitor_state (
  class_name TEXT PRIMARY KEY,
  in_lark_active_view BOOLEAN NOT NULL,
  erp_source_found BOOLEAN NOT NULL DEFAULT false,
  classroom_source_found BOOLEAN NOT NULL DEFAULT false,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  absent_since TIMESTAMPTZ
);

CREATE TABLE mapping.erp_class_membership_snapshot (
  erp_course_class_id BIGINT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  erp_class_name_snapshot TEXT NOT NULL,
  erp_student_name_snapshot TEXT NOT NULL,
  erp_student_email_snapshot TEXT,
  registration_status TEXT,
  registration_updated_at TIMESTAMPTZ,
  source_state TEXT NOT NULL DEFAULT 'active'
    CHECK (source_state IN ('active', 'missing')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  missing_since TIMESTAMPTZ,
  sync_run_id BIGINT REFERENCES mapping.sync_run(id),
  PRIMARY KEY (erp_course_class_id, erp_student_contact_id)
);

CREATE TABLE mapping.class_change_event (
  id BIGSERIAL PRIMARY KEY,
  change_type TEXT NOT NULL CHECK (change_type IN (
    'lark_class_added_to_view',
    'lark_class_removed_from_view',
    'erp_class_source_missing',
    'erp_class_source_restored',
    'classroom_class_source_missing',
    'classroom_class_source_restored',
    'classroom_student_removed',
    'classroom_student_returned',
    'erp_registration_flagged',
    'erp_registration_status_changed',
    'erp_student_missing_from_source',
    'erp_student_returned_to_source'
  )),
  erp_course_class_id BIGINT,
  class_name_snapshot TEXT,
  erp_student_contact_id BIGINT,
  classroom_course_id TEXT,
  google_user_id TEXT,
  previous_value TEXT,
  new_value TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id BIGINT REFERENCES mapping.sync_run(id)
);

CREATE INDEX idx_class_change_event_detected
  ON mapping.class_change_event (detected_at DESC);

CREATE INDEX idx_class_change_event_class_student
  ON mapping.class_change_event (erp_course_class_id, erp_student_contact_id);

CREATE TABLE mapping.student_identity_mapping (
  id BIGSERIAL PRIMARY KEY,
  erp_student_contact_id BIGINT NOT NULL UNIQUE,
  google_user_id TEXT NOT NULL UNIQUE,
  google_email_snapshot TEXT,
  erp_name_snapshot TEXT,
  google_name_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('approved', 'inactive', 'conflict')),
  match_method TEXT NOT NULL
    CHECK (match_method IN ('email', 'google_id', 'ai_suggested', 'teacher_confirmed', 'manual')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mapping.student_mapping_review (
  id BIGSERIAL PRIMARY KEY,
  erp_course_class_id BIGINT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  erp_student_code TEXT,
  erp_student_name_snapshot TEXT NOT NULL,
  erp_student_email_snapshot TEXT,
  classroom_course_id TEXT,
  classroom_user_id TEXT,
  classroom_name_snapshot TEXT,
  classroom_email_snapshot TEXT,
  ai_score NUMERIC(5, 4) CHECK (ai_score IS NULL OR ai_score BETWEEN 0 AND 1),
  ai_reason TEXT,
  match_method TEXT NOT NULL DEFAULT 'pending'
    CHECK (match_method IN ('email', 'google_id', 'ai_suggested', 'teacher_confirmed', 'manual', 'pending')),
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected', 'superseded')),
  reviewer_email TEXT,
  reviewer_note TEXT,
  decided_at TIMESTAMPTZ,
  source_run_id BIGINT REFERENCES mapping.sync_run(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT student_mapping_review_class_student_key
    UNIQUE (erp_course_class_id, erp_student_contact_id)
);

CREATE INDEX idx_review_class_status
  ON mapping.student_mapping_review (erp_course_class_id, status);

CREATE TABLE mapping.mapping_decision_event (
  id BIGSERIAL PRIMARY KEY,
  review_id BIGINT NOT NULL REFERENCES mapping.student_mapping_review(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'choose_another')),
  selected_google_user_id TEXT,
  reviewer_email TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE VIEW mapping.approved_student_classroom_mapping AS
SELECT
  erp_student_contact_id,
  google_user_id,
  google_email_snapshot,
  erp_name_snapshot,
  google_name_snapshot,
  approved_by,
  approved_at
FROM mapping.student_identity_mapping
WHERE status = 'approved';
