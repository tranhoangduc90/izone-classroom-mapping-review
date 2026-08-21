-- Mục đích: lưu trạng thái ghép điểm Writing trước khi chuyển sang Portal.
-- Dữ liệu nhận vào: ID kỹ thuật Classroom/ERP, điểm Band và thời gian nhận điểm; không lưu bài viết hoặc nhận xét chấm.
-- Kết quả: một bản ghi cho mỗi học viên - kỳ test, kèm đồng hồ chờ và nhật ký xử lý chống trùng.
-- Khi lỗi: toàn bộ migration rollback, không để lại bảng hoặc quyền dở dang.

BEGIN;

CREATE SCHEMA IF NOT EXISTS assessment;

CREATE TABLE IF NOT EXISTS assessment.writing_test_definition (
  test_key TEXT PRIMARY KEY,
  course_number SMALLINT NOT NULL CHECK (course_number IN (56, 67)),
  test_number SMALLINT NOT NULL CHECK (test_number IN (1, 2)),
  display_name TEXT NOT NULL,
  portal_test_name TEXT NOT NULL,
  aggregation_mode TEXT NOT NULL CHECK (aggregation_mode IN ('direct', 'weighted_tasks')),
  wait_minutes INTEGER NOT NULL DEFAULT 720 CHECK (wait_minutes BETWEEN 15 AND 2880),
  enabled BOOLEAN NOT NULL DEFAULT false,
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  lark_config_record_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_number, test_number)
);

INSERT INTO assessment.writing_test_definition (
  test_key, course_number, test_number, display_name, portal_test_name, aggregation_mode, enabled
) VALUES
  ('course-56-term-1', 56, 1, 'Khóa 56 - Term Test 1 Writing', 'Term Test 1 Writing', 'direct', false),
  ('course-56-term-2', 56, 2, 'Khóa 56 - Term Test 2 Writing', 'Term Test 2 Writing', 'direct', false),
  ('course-67-phase-1', 67, 1, 'Khóa 67 - Phase 1 Writing', 'Phase 1 Writing', 'direct', false),
  ('course-67-phase-2', 67, 2, 'Khóa 67 - Phase 2 Writing', 'Phase 2 Writing', 'weighted_tasks', false)
ON CONFLICT (test_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS assessment.writing_test_source (
  classroom_course_id TEXT NOT NULL,
  classroom_coursework_id TEXT NOT NULL,
  test_key TEXT NOT NULL REFERENCES assessment.writing_test_definition(test_key) ON DELETE CASCADE,
  component TEXT NOT NULL CHECK (component IN ('direct', 'task1', 'task2')),
  source_title_snapshot TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  lark_config_record_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (classroom_course_id, classroom_coursework_id),
  CHECK (
    (component = 'direct' AND test_key <> 'course-67-phase-2')
    OR (component IN ('task1', 'task2') AND test_key = 'course-67-phase-2')
  )
);

CREATE TABLE IF NOT EXISTS assessment.writing_test_class_scope (
  test_key TEXT NOT NULL REFERENCES assessment.writing_test_definition(test_key) ON DELETE CASCADE,
  erp_course_class_id BIGINT NOT NULL,
  class_name_snapshot TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  lark_config_record_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (test_key, erp_course_class_id)
);

CREATE TABLE IF NOT EXISTS assessment.writing_test_result (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_key TEXT NOT NULL REFERENCES assessment.writing_test_definition(test_key),
  erp_course_class_id BIGINT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  google_user_id TEXT NOT NULL,
  class_name_snapshot TEXT NOT NULL,
  student_name_snapshot TEXT NOT NULL,
  direct_score NUMERIC(3, 1) CHECK (direct_score IS NULL OR direct_score BETWEEN 0 AND 9),
  task1_score NUMERIC(3, 1) CHECK (task1_score IS NULL OR task1_score BETWEEN 0 AND 9),
  task2_score NUMERIC(3, 1) CHECK (task2_score IS NULL OR task2_score BETWEEN 0 AND 9),
  direct_source_record_id TEXT,
  task1_source_record_id TEXT,
  task2_source_record_id TEXT,
  direct_scored_at TIMESTAMPTZ,
  task1_scored_at TIMESTAMPTZ,
  task2_scored_at TIMESTAMPTZ,
  first_score_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  writing_overall NUMERIC(3, 1) CHECK (writing_overall IS NULL OR writing_overall BETWEEN 0 AND 9),
  missing_component TEXT CHECK (missing_component IS NULL OR missing_component IN ('task1', 'task2')),
  status TEXT NOT NULL CHECK (status IN (
    'waiting', 'ready', 'ready_zero', 'ready_late', 'synced', 'paused', 'conflict', 'error'
  )),
  used_zero BOOLEAN NOT NULL DEFAULT false,
  lark_record_id TEXT,
  last_portal_grade NUMERIC(3, 1) CHECK (last_portal_grade IS NULL OR last_portal_grade BETWEEN 0 AND 9),
  portal_synced_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (test_key, erp_course_class_id, erp_student_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_writing_test_result_due
  ON assessment.writing_test_result (expires_at, test_key, erp_course_class_id)
  WHERE status IN ('waiting', 'paused');

CREATE INDEX IF NOT EXISTS idx_writing_test_result_ready
  ON assessment.writing_test_result (updated_at)
  WHERE status IN ('ready', 'ready_zero', 'ready_late');

CREATE TABLE IF NOT EXISTS assessment.writing_test_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  result_id UUID REFERENCES assessment.writing_test_result(id) ON DELETE SET NULL,
  classroom_course_id TEXT NOT NULL,
  classroom_coursework_id TEXT NOT NULL,
  google_user_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  component TEXT,
  score NUMERIC(3, 1) CHECK (score IS NULL OR score BETWEEN 0 AND 9),
  scored_at TIMESTAMPTZ,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN (
    'stored', 'duplicate', 'source_not_configured', 'identity_not_mapped', 'class_not_resolved', 'invalid'
  )),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_writing_test_event_created
  ON assessment.writing_test_event (created_at DESC);

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_review_api') THEN
    GRANT USAGE ON SCHEMA assessment TO mapping_review_api;
    GRANT USAGE ON SCHEMA mapping TO mapping_review_api;
    GRANT SELECT, INSERT, UPDATE ON assessment.writing_test_definition TO mapping_review_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON assessment.writing_test_source TO mapping_review_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON assessment.writing_test_class_scope TO mapping_review_api;
    GRANT SELECT, INSERT, UPDATE ON assessment.writing_test_result TO mapping_review_api;
    GRANT SELECT, INSERT, DELETE ON assessment.writing_test_event TO mapping_review_api;
    GRANT SELECT ON mapping.student_identity_mapping, mapping.erp_class_membership_snapshot TO mapping_review_api;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_app') THEN
    GRANT USAGE ON SCHEMA assessment TO mapping_app;
    GRANT USAGE ON SCHEMA mapping TO mapping_app;
    GRANT SELECT, INSERT, UPDATE ON assessment.writing_test_definition TO mapping_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON assessment.writing_test_source TO mapping_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON assessment.writing_test_class_scope TO mapping_app;
    GRANT SELECT, INSERT, UPDATE ON assessment.writing_test_result TO mapping_app;
    GRANT SELECT, INSERT, DELETE ON assessment.writing_test_event TO mapping_app;
    GRANT SELECT ON mapping.student_identity_mapping, mapping.erp_class_membership_snapshot TO mapping_app;
  END IF;
END
$permissions$;

COMMIT;
