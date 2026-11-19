BEGIN;
SET LOCAL lock_timeout = '5s';

-- Offline paper journeys use legacy native sessions and a signed paper binding.
-- The attempt trigger and unique index continue to protect the shared grade key.
ALTER TABLE assessment.term_test_exam_session
  DROP CONSTRAINT term1_parallel_entry_session_scope,
  ADD CONSTRAINT term1_parallel_entry_session_scope CHECK (
    NOT term1_parallel_entry OR (test_slug = 'term-test-1' AND attempt_mode IN ('cbt','legacy'))
  );

COMMIT;
