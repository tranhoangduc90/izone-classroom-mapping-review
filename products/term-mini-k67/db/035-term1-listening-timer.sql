BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS assessment.term1_listening_timer_room (
  class_id bigint PRIMARY KEY,
  starts_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL CHECK (deadline_at > starts_at),
  audio_confirmed_at timestamptz
);
ALTER TABLE assessment.term1_listening_timer_room ADD COLUMN IF NOT EXISTS audio_confirmed_at timestamptz;
ALTER TABLE assessment.term1_listening_timer_room ADD COLUMN IF NOT EXISTS audio_held boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS assessment.term1_listening_timer_session (
  session_id uuid PRIMARY KEY REFERENCES assessment.term_test_exam_session(id),
  class_id bigint NOT NULL REFERENCES assessment.term1_listening_timer_room(class_id),
  device_hash text,
  submit_id uuid NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS term1_timer_room_sessions ON assessment.term1_listening_timer_session(class_id);
GRANT SELECT ON assessment.term1_listening_timer_room TO k67_app;
GRANT INSERT, UPDATE(deadline_at,audio_confirmed_at,audio_held) ON assessment.term1_listening_timer_room TO k67_app;
GRANT SELECT, INSERT ON assessment.term1_listening_timer_session TO k67_app;

CREATE OR REPLACE FUNCTION assessment.guard_term1_timer_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.listening_started_at, NEW.listening_deadline_at, NEW.listening_draft, NEW.listening_draft_revision,
      NEW.listening_submitted_at, NEW.attempt_id, NEW.audio_owner_protocol, NEW.superseded_at)
      IS DISTINCT FROM (OLD.listening_started_at, OLD.listening_deadline_at, OLD.listening_draft, OLD.listening_draft_revision,
      OLD.listening_submitted_at, OLD.attempt_id, OLD.audio_owner_protocol, OLD.superseded_at)
      AND EXISTS (SELECT 1 FROM assessment.term1_listening_timer_session WHERE session_id=OLD.id AND device_hash IS NOT NULL)
      AND current_setting('k67.timer_session', true) IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'TIMER_SESSION_REQUIRED' USING ERRCODE='P6740';
  END IF;
  IF NEW.listening_started_at IS NOT NULL AND NEW.listening_submitted_at IS NULL THEN
    SELECT coalesce((SELECT r.deadline_at FROM assessment.term1_listening_timer_session t
      JOIN assessment.term1_listening_timer_room r ON r.class_id=t.class_id WHERE t.session_id=OLD.id),
      NEW.listening_deadline_at) INTO NEW.listening_deadline_at;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS term1_timer_session_guard ON assessment.term_test_exam_session;
CREATE TRIGGER term1_timer_session_guard BEFORE UPDATE ON assessment.term_test_exam_session
  FOR EACH ROW WHEN (OLD.test_slug='term-test-1') EXECUTE FUNCTION assessment.guard_term1_timer_session();

CREATE OR REPLACE FUNCTION assessment.guard_term1_timer_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.listening_submitted_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM assessment.term1_listening_timer_session t
    JOIN assessment.term_test_exam_session s ON s.id=t.session_id
    WHERE t.device_hash IS NOT NULL AND s.erp_course_class_id=NEW.erp_course_class_id
      AND s.erp_student_contact_id=NEW.erp_student_contact_id AND s.definition_version=NEW.definition_version
      AND s.superseded_at IS NULL AND current_setting('k67.timer_session', true) IS DISTINCT FROM s.id::text
  ) THEN
    RAISE EXCEPTION 'TIMER_SESSION_REQUIRED' USING ERRCODE='P6740';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS term1_timer_attempt_guard ON assessment.term_test_attempt;
CREATE TRIGGER term1_timer_attempt_guard BEFORE INSERT OR UPDATE OF listening_submitted_at ON assessment.term_test_attempt
  FOR EACH ROW WHEN (NEW.test_slug='term-test-1') EXECUTE FUNCTION assessment.guard_term1_timer_attempt();

CREATE OR REPLACE FUNCTION assessment.apply_term1_timer_room_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE enrolled uuid;
BEGIN
  IF (OLD.deadline_at<=clock_timestamp() AND NOT OLD.audio_held) OR NEW.deadline_at < OLD.deadline_at OR OLD.starts_at<>NEW.starts_at THEN
    RAISE EXCEPTION 'TIMER_ROOM_DEADLINE_LOCKED';
  END IF;
  FOR enrolled IN SELECT session_id FROM assessment.term1_listening_timer_session WHERE class_id=NEW.class_id ORDER BY session_id LOOP
    PERFORM set_config('k67.timer_session',enrolled::text,true);
    UPDATE assessment.term_test_exam_session SET listening_deadline_at=NEW.deadline_at
      WHERE id=enrolled AND listening_started_at IS NOT NULL AND listening_submitted_at IS NULL AND superseded_at IS NULL;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS term1_timer_room_deadline ON assessment.term1_listening_timer_room;
CREATE TRIGGER term1_timer_room_deadline AFTER UPDATE OF starts_at, deadline_at ON assessment.term1_listening_timer_room
  FOR EACH ROW EXECUTE FUNCTION assessment.apply_term1_timer_room_deadline();
COMMIT;
