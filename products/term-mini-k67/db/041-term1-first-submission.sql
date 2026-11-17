BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assessment.term_test_attempt
  ADD COLUMN term1_first_submission_guard boolean NOT NULL DEFAULT false;

-- Only newly received submissions enter this index. Historical results can already
-- conflict and must remain readable for reconciliation.
CREATE UNIQUE INDEX uq_term1_new_official_attempt
  ON assessment.term_test_attempt (definition_version, erp_course_class_id, erp_student_contact_id)
  WHERE term1_first_submission_guard AND superseded_at IS NULL;

CREATE FUNCTION assessment.guard_term1_first_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.term1_first_submission_guard AND OLD.superseded_at IS NULL
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
      RAISE EXCEPTION 'TERM1_OFFICIAL_SUBMISSION_IMMUTABLE' USING ERRCODE = 'P6742';
    END IF;
  END IF;

  IF NEW.test_slug <> 'term-test-1' OR NEW.superseded_at IS NOT NULL
      OR (NEW.listening_submitted_at IS NULL AND NEW.reading_submitted_at IS NULL) THEN
    NEW.term1_first_submission_guard := false;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.test_slug = NEW.test_slug AND OLD.superseded_at IS NULL
      AND ROW(OLD.definition_version, OLD.erp_course_class_id, OLD.erp_student_contact_id)
          IS NOT DISTINCT FROM ROW(NEW.definition_version, NEW.erp_course_class_id, NEW.erp_student_contact_id)
      AND (OLD.listening_submitted_at IS NOT NULL OR OLD.reading_submitted_at IS NOT NULL) THEN
    NEW.term1_first_submission_guard := OLD.term1_first_submission_guard;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM assessment.term_test_attempt AS accepted
    WHERE accepted.test_slug = NEW.test_slug
      AND accepted.definition_version = NEW.definition_version
      AND accepted.erp_course_class_id = NEW.erp_course_class_id
      AND accepted.erp_student_contact_id = NEW.erp_student_contact_id
      AND accepted.id <> NEW.id
      AND accepted.superseded_at IS NULL
      AND (accepted.listening_submitted_at IS NOT NULL OR accepted.reading_submitted_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'TERM1_FIRST_SUBMISSION_ALREADY_ACCEPTED' USING ERRCODE = 'P6741';
  END IF;

  NEW.term1_first_submission_guard := true;
  RETURN NEW;
END $$;

CREATE TRIGGER term1_first_submission_guard
  BEFORE INSERT OR UPDATE ON assessment.term_test_attempt
  FOR EACH ROW EXECUTE FUNCTION assessment.guard_term1_first_submission();

COMMIT;
