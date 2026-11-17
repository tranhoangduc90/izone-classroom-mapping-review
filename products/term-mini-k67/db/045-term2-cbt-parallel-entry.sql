BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN term2_parallel_entry boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT term2_parallel_entry_session_scope CHECK (
    NOT term2_parallel_entry OR (test_slug = 'term-test-2' AND attempt_mode = 'cbt')
  );
ALTER TABLE assessment.term_test_attempt
  ADD COLUMN term2_parallel_entry boolean NOT NULL DEFAULT false,
  ADD COLUMN term2_first_submission_guard boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT term2_parallel_entry_attempt_scope CHECK (
    NOT term2_parallel_entry OR (test_slug = 'term-test-2' AND exam_session_id IS NOT NULL)
  );

-- Existing conflicting historical results remain intact. Only new receipts enter this index.
CREATE UNIQUE INDEX uq_term2_new_official_attempt
  ON assessment.term_test_attempt (definition_version, erp_course_class_id, erp_student_contact_id)
  WHERE term2_first_submission_guard AND superseded_at IS NULL;

CREATE FUNCTION assessment.guard_term2_first_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.test_slug = 'term-test-2' AND OLD.superseded_at IS NULL
      AND NEW.superseded_at IS NULL AND OLD.generation = NEW.generation THEN
    IF (OLD.listening_submitted_at IS NOT NULL
        AND ROW(OLD.listening_submitted_at, OLD.listening_answers)
            IS DISTINCT FROM ROW(NEW.listening_submitted_at, NEW.listening_answers))
      OR (OLD.reading_submitted_at IS NOT NULL
        AND ROW(OLD.reading_submitted_at, OLD.reading_answers)
            IS DISTINCT FROM ROW(NEW.reading_submitted_at, NEW.reading_answers))
      OR (OLD.writing_submitted_at IS NOT NULL
        AND ROW(OLD.writing_submitted_at, OLD.writing_task_1, OLD.writing_task_2)
            IS DISTINCT FROM ROW(NEW.writing_submitted_at, NEW.writing_task_1, NEW.writing_task_2)) THEN
      RAISE EXCEPTION 'TERM2_OFFICIAL_SUBMISSION_IMMUTABLE' USING ERRCODE = 'P6752';
    END IF;
  END IF;

  IF NEW.test_slug <> 'term-test-2' OR NEW.superseded_at IS NOT NULL
      OR (NEW.listening_submitted_at IS NULL AND NEW.reading_submitted_at IS NULL) THEN
    NEW.term2_first_submission_guard := false;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.test_slug = NEW.test_slug AND OLD.superseded_at IS NULL
      AND ROW(OLD.definition_version, OLD.erp_course_class_id, OLD.erp_student_contact_id, OLD.generation)
          IS NOT DISTINCT FROM ROW(NEW.definition_version, NEW.erp_course_class_id, NEW.erp_student_contact_id, NEW.generation)
      AND (OLD.listening_submitted_at IS NOT NULL OR OLD.reading_submitted_at IS NOT NULL)
      AND (OLD.term2_first_submission_guard OR NOT (
        (OLD.listening_submitted_at IS NULL AND NEW.listening_submitted_at IS NOT NULL)
        OR (OLD.reading_submitted_at IS NULL AND NEW.reading_submitted_at IS NOT NULL)
        OR (OLD.writing_submitted_at IS NULL AND NEW.writing_submitted_at IS NOT NULL)
      )) THEN
    NEW.term2_first_submission_guard := OLD.term2_first_submission_guard;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM assessment.term_test_attempt AS accepted
    WHERE accepted.test_slug = NEW.test_slug
      AND accepted.definition_version = NEW.definition_version
      AND accepted.erp_course_class_id = NEW.erp_course_class_id
      AND accepted.erp_student_contact_id = NEW.erp_student_contact_id
      AND accepted.id <> NEW.id AND accepted.superseded_at IS NULL
      AND (accepted.listening_submitted_at IS NOT NULL OR accepted.reading_submitted_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'TERM2_FIRST_SUBMISSION_ALREADY_ACCEPTED' USING ERRCODE = 'P6751';
  END IF;

  NEW.term2_first_submission_guard := true;
  RETURN NEW;
END $$;

CREATE TRIGGER term2_first_submission_guard
  BEFORE INSERT OR UPDATE ON assessment.term_test_attempt
  FOR EACH ROW EXECUTE FUNCTION assessment.guard_term2_first_submission();

CREATE FUNCTION assessment.bind_term2_parallel_entry_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.term2_parallel_entry := NEW.test_slug = 'term-test-2' AND EXISTS (
    SELECT 1 FROM assessment.term_test_exam_session s
    WHERE s.id = NEW.exam_session_id AND s.term2_parallel_entry AND s.superseded_at IS NULL
      AND ROW(s.test_slug, s.definition_version, s.erp_course_class_id, s.erp_student_contact_id, s.generation)
        = ROW(NEW.test_slug, NEW.definition_version, NEW.erp_course_class_id, NEW.erp_student_contact_id, NEW.generation)
  );
  RETURN NEW;
END $$;

CREATE TRIGGER term2_bind_parallel_entry_attempt
  BEFORE INSERT OR UPDATE OF exam_session_id, term2_parallel_entry, test_slug, definition_version,
    erp_course_class_id, erp_student_contact_id, generation ON assessment.term_test_attempt
  FOR EACH ROW EXECUTE FUNCTION assessment.bind_term2_parallel_entry_attempt();

DROP INDEX assessment.uq_term_test_exam_session_one_active_student;
CREATE UNIQUE INDEX uq_term_test_exam_session_one_active_student
  ON assessment.term_test_exam_session (test_slug, definition_version, erp_course_class_id, erp_student_contact_id)
  WHERE listening_submitted_at IS NULL AND superseded_at IS NULL AND NOT term1_parallel_entry AND NOT term2_parallel_entry;

DROP INDEX assessment.uq_term_test_attempt_one_active_student;
CREATE UNIQUE INDEX uq_term_test_attempt_one_active_student
  ON assessment.term_test_attempt (test_slug, definition_version, erp_course_class_id, erp_student_contact_id)
  WHERE completed_at IS NULL AND superseded_at IS NULL AND NOT term1_parallel_entry AND NOT term2_parallel_entry;

COMMIT;
