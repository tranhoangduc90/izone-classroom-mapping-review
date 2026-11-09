BEGIN;
SET LOCAL lock_timeout = '200ms';
SET LOCAL statement_timeout = '2s';
LOCK TABLE ONLY assessment.term_test_attempt IN ACCESS EXCLUSIVE MODE NOWAIT;

ALTER TABLE assessment.term_test_attempt
  DROP CONSTRAINT term1_listening_interruption_check,
  ADD CONSTRAINT k56_listening_interruption_check CHECK (
    listening_interrupted_at IS NULL OR (
      test_slug IN ('term-test-1-k56', 'term-test-2-k56', 'mini-test-k56')
      AND attempt_mode = 'cbt'
      AND listening_submitted_at IS NULL AND listening_result IS NULL
    )
  ) NOT VALID;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '200ms';
SET LOCAL statement_timeout = '5s';
ALTER TABLE assessment.term_test_attempt VALIDATE CONSTRAINT k56_listening_interruption_check;
COMMIT;
