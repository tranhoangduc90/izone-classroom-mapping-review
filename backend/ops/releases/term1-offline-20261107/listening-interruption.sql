BEGIN;
SET LOCAL lock_timeout = '200ms';
SET LOCAL statement_timeout = '2s';
LOCK TABLE ONLY assessment.term_test_attempt IN ACCESS EXCLUSIVE MODE NOWAIT;

ALTER TABLE assessment.term_test_attempt
  ADD COLUMN listening_interrupted_at timestamptz,
  ADD CONSTRAINT term1_listening_interruption_check CHECK (
    listening_interrupted_at IS NULL OR (
      test_slug = 'term-test-1-k56' AND attempt_mode = 'cbt'
      AND listening_submitted_at IS NULL AND listening_result IS NULL
    )
  ) NOT VALID,
  DROP CONSTRAINT term_test_attempt_writing_order_check,
  ADD CONSTRAINT term_test_attempt_writing_order_check CHECK (
    (writing_started_at IS NULL AND writing_updated_at IS NULL AND writing_submitted_at IS NULL)
    OR (
      (completed_at IS NOT NULL OR (listening_interrupted_at IS NOT NULL AND reading_submitted_at IS NOT NULL))
      AND writing_started_at IS NOT NULL AND writing_updated_at IS NOT NULL
      AND (writing_submitted_at IS NULL OR writing_submitted_at >= writing_started_at)
    )
  ) NOT VALID;
COMMIT;

-- The checks already apply to new writes. Validate historical rows separately from the short lock.
BEGIN;
SET LOCAL lock_timeout = '200ms';
SET LOCAL statement_timeout = '5s';
ALTER TABLE assessment.term_test_attempt
  VALIDATE CONSTRAINT term1_listening_interruption_check,
  VALIDATE CONSTRAINT term_test_attempt_writing_order_check;
COMMIT;
