BEGIN;
ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN IF NOT EXISTS listening_eof_version smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS listening_eof_at timestamptz;
COMMIT;
