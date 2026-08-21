-- Mục đích: lưu trạng thái, retry và kết quả chấm Writing của bài thi máy trong PostgreSQL.
-- Dữ liệu nhận vào: bài đã nộp theo attempt token và kết quả chấm có cấu trúc từ n8n.
-- Kết quả: từng việc/tiêu chí có trạng thái riêng; điểm chỉ mở khi Task 1 và Task 2 đều hoàn tất.
-- Khi lỗi: toàn bộ migration rollback, không thay đổi dữ liệu bài thi đang có.

BEGIN;

CREATE TABLE IF NOT EXISTS assessment.term_test_writing_grading_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES assessment.term_test_attempt(id) ON DELETE CASCADE,
  task_number SMALLINT NOT NULL CHECK (task_number IN (1, 2)),
  grading_version INTEGER NOT NULL DEFAULT 1 CHECK (grading_version > 0),
  run_key TEXT NOT NULL UNIQUE,
  prompt_text TEXT NOT NULL,
  prompt_image_url TEXT,
  essay_text TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'retry_wait', 'grading', 'complete', 'review_required', 'failed')),
  lark_record_id TEXT,
  task_score NUMERIC(2, 1) CHECK (task_score IS NULL OR task_score BETWEEN 0 AND 9),
  result_json JSONB,
  last_error_code TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, task_number, grading_version)
);

CREATE TABLE IF NOT EXISTS assessment.term_test_writing_grading_component (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES assessment.term_test_writing_grading_run(id) ON DELETE CASCADE,
  criterion_code TEXT NOT NULL CHECK (criterion_code IN ('TA', 'TR', 'CC', 'LR', 'GRA')),
  component_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'processing', 'complete', 'retry_wait', 'failed')),
  label TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  feedback TEXT NOT NULL DEFAULT '',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, component_code)
);

CREATE TABLE IF NOT EXISTS assessment.term_test_writing_grading_criterion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES assessment.term_test_writing_grading_run(id) ON DELETE CASCADE,
  criterion_code TEXT NOT NULL CHECK (criterion_code IN ('TA', 'TR', 'CC', 'LR', 'GRA')),
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'processing', 'complete', 'retry_wait', 'failed')),
  band_score NUMERIC(2, 1) CHECK (band_score IS NULL OR band_score BETWEEN 0 AND 9),
  feedback TEXT NOT NULL DEFAULT '',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, criterion_code)
);

CREATE TABLE IF NOT EXISTS assessment.term_test_writing_grading_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES assessment.term_test_writing_grading_run(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('dispatch', 'collect')),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'retry_wait', 'complete', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  worker_id TEXT,
  leased_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  last_error_code TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assessment.term_test_writing_grading_final (
  attempt_id UUID PRIMARY KEY REFERENCES assessment.term_test_attempt(id) ON DELETE CASCADE,
  grading_version INTEGER NOT NULL DEFAULT 1 CHECK (grading_version > 0),
  task_1_run_id UUID REFERENCES assessment.term_test_writing_grading_run(id),
  task_2_run_id UUID REFERENCES assessment.term_test_writing_grading_run(id),
  task_1_score NUMERIC(2, 1) CHECK (task_1_score IS NULL OR task_1_score BETWEEN 0 AND 9),
  task_2_score NUMERIC(2, 1) CHECK (task_2_score IS NULL OR task_2_score BETWEEN 0 AND 9),
  writing_score NUMERIC(2, 1) CHECK (writing_score IS NULL OR writing_score BETWEEN 0 AND 9),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'ready')),
  ready_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_term_test_writing_grading_job_ready
  ON assessment.term_test_writing_grading_job (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_term_test_writing_grading_run_attempt
  ON assessment.term_test_writing_grading_run (attempt_id, grading_version, task_number);

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_review_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      assessment.term_test_writing_grading_run,
      assessment.term_test_writing_grading_component,
      assessment.term_test_writing_grading_criterion,
      assessment.term_test_writing_grading_job,
      assessment.term_test_writing_grading_final
    TO mapping_review_api;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      assessment.term_test_writing_grading_run,
      assessment.term_test_writing_grading_component,
      assessment.term_test_writing_grading_criterion,
      assessment.term_test_writing_grading_job,
      assessment.term_test_writing_grading_final
    TO mapping_app;
  END IF;
END
$permissions$;

COMMIT;
