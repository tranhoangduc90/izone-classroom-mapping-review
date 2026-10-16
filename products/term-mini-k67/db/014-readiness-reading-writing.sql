-- Nháp và bài nộp làm quen riêng cho từng kỹ năng; không chạm dữ liệu bài thi.
BEGIN;
ALTER TABLE assessment.k67_readiness_session
  ADD COLUMN reading_draft jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN reading_revision bigint NOT NULL DEFAULT 0 CHECK (reading_revision >= 0),
  ADD COLUMN reading_submitted_at timestamptz,
  ADD COLUMN writing_draft jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN writing_revision bigint NOT NULL DEFAULT 0 CHECK (writing_revision >= 0),
  ADD COLUMN writing_submitted_at timestamptz;
COMMIT;
