-- Dàn ý và thời gian riêng cho từng Task; không sửa bài viết hoặc kết quả chấm hiện có.
CREATE TABLE IF NOT EXISTS assessment.term_test_writing_planning (
  attempt_id UUID NOT NULL REFERENCES assessment.term_test_attempt(id) ON DELETE CASCADE,
  task_number SMALLINT NOT NULL CHECK (task_number IN (1, 2)),
  started_at TIMESTAMPTZ NOT NULL,
  planning_deadline_at TIMESTAMPTZ NOT NULL,
  outline_text TEXT NOT NULL DEFAULT '' CHECK (length(outline_text) <= 12000),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, task_number),
  CHECK (planning_deadline_at >= started_at)
);
GRANT SELECT, INSERT, UPDATE ON assessment.term_test_writing_planning TO k67_app;
