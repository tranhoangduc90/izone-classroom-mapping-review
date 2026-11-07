BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS assessment.term_k67_cbt_journey (
  session_id uuid PRIMARY KEY REFERENCES assessment.term_test_exam_session(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  student_ref uuid NOT NULL,
  device_hash text NOT NULL,
  activated_at timestamptz,
  audio_hash text NOT NULL,
  sections jsonb NOT NULL DEFAULT '{}'::jsonb
);
GRANT SELECT, INSERT, UPDATE ON assessment.term_k67_cbt_journey TO k67_app;

CREATE OR REPLACE FUNCTION assessment.guard_term_k67_cbt_journey() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  token uuid;
  revision bigint;
BEGIN
  IF NEW.test_slug NOT IN ('term-test-1','term-test-2') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='term_test_exam_session' THEN
    IF ROW(NEW.listening_started_at,NEW.listening_submitted_at,NEW.listening_deadline_at,NEW.listening_draft,
        NEW.listening_draft_revision,NEW.listening_eof_at)
      IS NOT DISTINCT FROM ROW(OLD.listening_started_at,OLD.listening_submitted_at,OLD.listening_deadline_at,
        OLD.listening_draft,OLD.listening_draft_revision,OLD.listening_eof_at) THEN RETURN NEW; END IF;
    token := NEW.id;
    revision := NEW.generation;
  ELSE
    token := NEW.exam_session_id;
    revision := NEW.generation;
    IF TG_OP='INSERT' THEN
      IF token IS NULL AND NEW.listening_submitted_at IS NOT NULL THEN
        SELECT s.id,s.generation INTO token,revision FROM assessment.term_test_exam_session s
          JOIN assessment.term_k67_cbt_journey j ON j.session_id=s.id AND j.generation=s.generation
          WHERE s.test_slug=NEW.test_slug AND s.definition_version=NEW.definition_version AND s.superseded_at IS NULL
            AND s.erp_course_class_id=NEW.erp_course_class_id AND s.erp_student_contact_id=NEW.erp_student_contact_id
            AND j.activated_at IS NOT NULL ORDER BY s.prepared_at DESC LIMIT 1;
      ELSE
        SELECT generation INTO revision FROM assessment.term_test_exam_session WHERE id=token;
      END IF;
    ELSIF ROW(NEW.reading_started_at,NEW.reading_submitted_at,NEW.listening_submitted_at,NEW.reading_deadline_at,
        NEW.reading_draft,NEW.reading_draft_revision,NEW.writing_started_at,NEW.writing_submitted_at,
        NEW.writing_deadline_at,NEW.writing_task_1,NEW.writing_task_2,NEW.writing_draft_revision)
      IS NOT DISTINCT FROM ROW(OLD.reading_started_at,OLD.reading_submitted_at,OLD.listening_submitted_at,
        OLD.reading_deadline_at,OLD.reading_draft,OLD.reading_draft_revision,OLD.writing_started_at,OLD.writing_submitted_at,
        OLD.writing_deadline_at,OLD.writing_task_1,OLD.writing_task_2,OLD.writing_draft_revision) THEN RETURN NEW;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM assessment.term_k67_cbt_journey
      WHERE session_id=token AND generation=revision AND activated_at IS NOT NULL)
    AND current_setting('k67.term_journey',true) IS DISTINCT FROM token::text THEN
    RAISE EXCEPTION 'TERM_OFFLINE_JOURNEY_ACTIVE' USING ERRCODE='P6722';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS term_test_cbt_journey_session ON assessment.term_test_exam_session;
CREATE TRIGGER term_test_cbt_journey_session BEFORE UPDATE ON assessment.term_test_exam_session
  FOR EACH ROW EXECUTE FUNCTION assessment.guard_term_k67_cbt_journey();
DROP TRIGGER IF EXISTS term_test_cbt_journey_attempt ON assessment.term_test_attempt;
CREATE TRIGGER term_test_cbt_journey_attempt BEFORE INSERT OR UPDATE ON assessment.term_test_attempt
  FOR EACH ROW EXECUTE FUNCTION assessment.guard_term_k67_cbt_journey();
COMMIT;
