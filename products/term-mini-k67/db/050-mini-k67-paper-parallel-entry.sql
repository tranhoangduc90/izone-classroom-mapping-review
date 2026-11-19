BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assessment.term_test_exam_session
  DROP CONSTRAINT mini_k67_parallel_entry_session_scope,
  ADD CONSTRAINT mini_k67_parallel_entry_session_scope CHECK (
    NOT mini_k67_parallel_entry OR (test_slug = 'mini-test-lesson-5' AND attempt_mode IN ('cbt', 'answer_sheet'))
  );

COMMIT;
