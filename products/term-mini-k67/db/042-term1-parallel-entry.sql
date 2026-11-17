BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('assessment.uq_term1_new_official_attempt') IS NULL THEN
    RAISE EXCEPTION 'Apply 041-term1-first-submission.sql before enabling parallel drafts';
  END IF;
END $$;

ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN term1_parallel_entry boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT term1_parallel_entry_session_scope CHECK (
    NOT term1_parallel_entry OR (test_slug = 'term-test-1' AND attempt_mode = 'cbt')
  );
ALTER TABLE assessment.term_test_attempt
  ADD COLUMN term1_parallel_entry boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT term1_parallel_entry_attempt_scope CHECK (
    NOT term1_parallel_entry OR (test_slug = 'term-test-1' AND exam_session_id IS NOT NULL)
  );

-- Sessions issued to independent profiles can keep draft progress at the same time.
-- Official submissions are separately protected by 041-term1-first-submission.sql.
DROP INDEX assessment.uq_term_test_exam_session_one_active_student;
CREATE UNIQUE INDEX uq_term_test_exam_session_one_active_student
  ON assessment.term_test_exam_session (test_slug, definition_version, erp_course_class_id, erp_student_contact_id)
  WHERE listening_submitted_at IS NULL AND superseded_at IS NULL AND NOT term1_parallel_entry;

DROP INDEX assessment.uq_term_test_attempt_one_active_student;
CREATE UNIQUE INDEX uq_term_test_attempt_one_active_student
  ON assessment.term_test_attempt (test_slug, definition_version, erp_course_class_id, erp_student_contact_id)
  WHERE completed_at IS NULL AND superseded_at IS NULL AND NOT term1_parallel_entry;

CREATE FUNCTION assessment.bind_term1_parallel_entry_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.term1_parallel_entry := NEW.test_slug = 'term-test-1' AND EXISTS (
    SELECT 1 FROM assessment.term_test_exam_session s
    WHERE s.id = NEW.exam_session_id AND s.term1_parallel_entry
      AND ROW(s.test_slug, s.definition_version, s.erp_course_class_id, s.erp_student_contact_id)
        = ROW(NEW.test_slug, NEW.definition_version, NEW.erp_course_class_id, NEW.erp_student_contact_id)
  );
  RETURN NEW;
END $$;

CREATE TRIGGER term1_bind_parallel_entry_attempt
  BEFORE INSERT OR UPDATE OF exam_session_id ON assessment.term_test_attempt
  FOR EACH ROW EXECUTE FUNCTION assessment.bind_term1_parallel_entry_attempt();

COMMIT;
