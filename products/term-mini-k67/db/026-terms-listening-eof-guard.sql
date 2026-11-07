BEGIN;
SET LOCAL lock_timeout='5s';
-- Bản 022 đã tạo trigger. Mở rộng đúng hai Term CBT đã opt-in; phiếu giấy không xin version 1.
CREATE OR REPLACE FUNCTION assessment.guard_term1_eof_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound assessment.term_test_exam_session%ROWTYPE;
BEGIN
  IF NEW.listening_submitted_at IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.listening_submitted_at IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.test_slug NOT IN ('term-test-1','term-test-2') OR NEW.exam_session_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO bound FROM assessment.term_test_exam_session WHERE id=NEW.exam_session_id FOR UPDATE;
  IF bound.listening_eof_version=1 AND current_setting('k67.submit_intent',true) IS DISTINCT FROM 'manual' THEN
    IF bound.listening_eof_at IS NULL THEN
      RAISE EXCEPTION 'AUDIO_END_NOT_CONFIRMED' USING ERRCODE='P6730';
    END IF;
    IF clock_timestamp() < bound.listening_eof_at + interval '120 seconds' THEN
      RAISE EXCEPTION 'LISTENING_REVIEW_ACTIVE' USING ERRCODE='P6731';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION assessment.guard_term1_eof_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.test_slug NOT IN ('term-test-1','term-test-2') OR OLD.listening_eof_version<>1
     OR OLD.listening_submitted_at IS NOT NULL OR NEW.listening_submitted_at IS NULL THEN RETURN NEW; END IF;
  IF current_setting('k67.submit_intent',true)='manual' THEN RETURN NEW; END IF;
  IF OLD.listening_eof_at IS NULL THEN
    RAISE EXCEPTION 'AUDIO_END_NOT_CONFIRMED' USING ERRCODE='P6730';
  END IF;
  IF clock_timestamp() < OLD.listening_eof_at + interval '120 seconds' THEN
    RAISE EXCEPTION 'LISTENING_REVIEW_ACTIVE' USING ERRCODE='P6731';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
