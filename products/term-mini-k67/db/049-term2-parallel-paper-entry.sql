BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assessment.term_test_exam_session
  DROP CONSTRAINT term2_parallel_entry_session_scope,
  ADD CONSTRAINT term2_parallel_entry_session_scope CHECK (
    NOT term2_parallel_entry OR (test_slug = 'term-test-2' AND attempt_mode IN ('cbt', 'legacy'))
  );

COMMIT;
