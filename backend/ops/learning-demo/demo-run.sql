-- Chỉ có trên kho demo. Nếu thiếu marker này, dịch vụ từ chối khởi động.
CREATE SCHEMA IF NOT EXISTS learning_demo;
CREATE SEQUENCE IF NOT EXISTS learning_demo.fake_class_id START WITH 990000000001;
CREATE TABLE IF NOT EXISTS learning_demo.environment_marker (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  kind TEXT NOT NULL CHECK (kind = 'progress_log_demo_only')
);
INSERT INTO learning_demo.environment_marker (id, kind)
VALUES (true, 'progress_log_demo_only') ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS learning_demo.run (
  id UUID PRIMARY KEY,
  source_token UUID NOT NULL,
  source_payload JSONB CHECK (source_payload IS NULL OR jsonb_typeof(source_payload) = 'object'),
  assignment_id UUID NOT NULL UNIQUE REFERENCES learning.form_assignment(id),
  teacher_token_hash TEXT NOT NULL UNIQUE CHECK (teacher_token_hash ~ '^[0-9a-f]{64}$'),
  teacher_email TEXT NOT NULL UNIQUE,
  class_id BIGINT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  reset_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS learning_demo_run_teacher_active_idx
  ON learning_demo.run (teacher_token_hash, expires_at) WHERE reset_at IS NULL;
