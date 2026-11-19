BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assessment.term_test_exam_session
  DROP CONSTRAINT pretest_parallel_entry_session_scope,
  ADD CONSTRAINT pretest_parallel_entry_session_scope CHECK (
    NOT pretest_parallel_entry OR (test_slug = 'pretest-lesson-16' AND attempt_mode IN ('cbt', 'legacy'))
  );

COMMIT;
