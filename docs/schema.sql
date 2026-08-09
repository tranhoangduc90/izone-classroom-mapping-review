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
    'classroom_student_added',
    'classroom_student_removed',
    'classroom_student_returned',
    'classroom_student_profile_changed',
    'erp_student_added_to_source',
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
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
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
  decision TEXT NOT NULL CHECK (decision IN (
    'approve', 'reject', 'choose_another', 'edit_mapping', 'reopen'
  )),
  selected_google_user_id TEXT,
  reviewer_email TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mapping.reviewer_account (
  email TEXT PRIMARY KEY,
  google_subject TEXT UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'teacher'
    CHECK (role IN ('teacher', 'admin')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  can_access_all_classes BOOLEAN NOT NULL DEFAULT false,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reviewer_account_email_lowercase_check
    CHECK (email = lower(email))
);

CREATE TABLE mapping.reviewer_class_assignment (
  reviewer_email TEXT NOT NULL
    REFERENCES mapping.reviewer_account(email) ON DELETE CASCADE,
  class_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reviewer_email, class_name),
  CONSTRAINT reviewer_class_assignment_name_not_blank_check
    CHECK (length(trim(class_name)) > 0)
);

CREATE INDEX idx_reviewer_class_assignment_normalized_name
  ON mapping.reviewer_class_assignment (upper(trim(class_name)));

CREATE TABLE mapping.reviewer_class_access (
  reviewer_email TEXT NOT NULL
    REFERENCES mapping.reviewer_account(email) ON DELETE CASCADE,
  erp_course_class_id BIGINT NOT NULL
    REFERENCES mapping.classroom_course_mapping(erp_course_class_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reviewer_email, erp_course_class_id)
);

CREATE INDEX idx_reviewer_class_access_class
  ON mapping.reviewer_class_access (erp_course_class_id);

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

-- Dữ liệu bài test được tách sang schema riêng nhưng vẫn nằm trong cùng database tích hợp.
CREATE SCHEMA IF NOT EXISTS assessment;

CREATE TABLE assessment.test_definition (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  listening_band_adjustment NUMERIC(3, 1) NOT NULL DEFAULT 0,
  listening_definition JSONB NOT NULL,
  reading_definition JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT test_definition_slug_check
    CHECK (slug ~ '^(term-test-[1-9][0-9]*|mini-test-[a-z0-9-]+)$')
);

CREATE TABLE assessment.term_test_roster (
  test_slug TEXT NOT NULL REFERENCES assessment.test_definition(slug) ON DELETE CASCADE,
  erp_course_class_id BIGINT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  student_ref UUID NOT NULL,
  student_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (test_slug, erp_course_class_id, erp_student_contact_id),
  UNIQUE (test_slug, student_ref)
);

CREATE TABLE assessment.term_test_attempt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_submission_id UUID NOT NULL,
  test_slug TEXT NOT NULL REFERENCES assessment.test_definition(slug),
  definition_version INTEGER NOT NULL,
  erp_course_class_id BIGINT NOT NULL,
  class_name_snapshot TEXT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  student_name_snapshot TEXT NOT NULL,
  listening_answers JSONB NOT NULL,
  listening_result JSONB NOT NULL,
  listening_submitted_at TIMESTAMPTZ NOT NULL,
  reading_answers JSONB,
  reading_result JSONB,
  combined_result JSONB,
  reading_submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (test_slug, client_submission_id)
);

CREATE INDEX idx_term_test_attempt_class_student
  ON assessment.term_test_attempt (erp_course_class_id, erp_student_contact_id, created_at DESC);

CREATE INDEX idx_term_test_attempt_completed
  ON assessment.term_test_attempt (test_slug, completed_at DESC)
  WHERE completed_at IS NOT NULL;

GRANT USAGE ON SCHEMA assessment TO mapping_review_api;
GRANT SELECT ON assessment.test_definition, assessment.term_test_roster TO mapping_review_api;
GRANT SELECT, INSERT, UPDATE ON assessment.term_test_attempt TO mapping_review_api;
