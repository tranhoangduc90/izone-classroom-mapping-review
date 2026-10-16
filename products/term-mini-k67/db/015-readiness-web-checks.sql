-- Báo cáo quan sát từ web, không phải chứng nhận thiết bị hoặc quyền vào bài thi thật.
BEGIN;
ALTER TABLE assessment.k67_readiness_session
  ADD COLUMN check_report jsonb,
  ADD COLUMN check_revision bigint NOT NULL DEFAULT 0 CHECK (check_revision >= 0),
  ADD COLUMN check_updated_at timestamptz;
COMMIT;
