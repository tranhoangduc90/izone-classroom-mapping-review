-- Nhận phiên K67 hiện có; bổ sung trạng thái giữ bài, không thay dữ liệu bài đã nộp.
ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN listening_audio_protocol_version integer NOT NULL DEFAULT 0 CHECK (listening_audio_protocol_version IN (0,1)),
  ADD COLUMN listening_audio_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN listening_audio_incident_id uuid;

CREATE TABLE assessment.term_test_audio_incident (
  incident_id uuid PRIMARY KEY,
  exam_session_id uuid NOT NULL REFERENCES assessment.term_test_exam_session(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  reason text NOT NULL CHECK (reason IN ('manual','pause','waiting','stalled','error','startup_failed')),
  anchor_seconds double precision NOT NULL CHECK (anchor_seconds >= 0 AND anchor_seconds <= 7200),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  remaining_ms bigint NOT NULL,
  needs_teacher boolean NOT NULL DEFAULT false,
  resume_attempt_id uuid,
  prepared_at timestamptz,
  confirm_event_id uuid,
  confirmed_seconds double precision,
  resolved_at timestamptz,
  granted_seconds integer NOT NULL DEFAULT 0 CHECK (granted_seconds BETWEEN 0 AND 900),
  UNIQUE(exam_session_id,event_id)
);
CREATE UNIQUE INDEX term_test_one_open_audio_incident
  ON assessment.term_test_audio_incident(exam_session_id) WHERE resolved_at IS NULL;
GRANT SELECT,INSERT,UPDATE ON assessment.term_test_audio_incident TO k67_app;

-- Mọi đường lưu/nộp đều chịu cùng khóa hàng, kể cả client cũ hoặc endpoint không token.
-- Lỗi P6701 được API đổi thành thông báo giữ bài; giao dịch lỗi không ghi điểm/nháp mới.
CREATE FUNCTION assessment.guard_audio_incident_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.listening_audio_protocol_version=1 AND OLD.listening_audio_incident_id IS NOT NULL
     AND ((OLD.listening_submitted_at IS NULL AND NEW.listening_submitted_at IS NOT NULL)
       OR NEW.listening_draft IS DISTINCT FROM OLD.listening_draft
       OR NEW.listening_draft_revision IS DISTINCT FROM OLD.listening_draft_revision) THEN
    RAISE EXCEPTION 'AUDIO_INCIDENT_OPEN' USING ERRCODE='P6701';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER term_test_audio_hold_session BEFORE UPDATE ON assessment.term_test_exam_session
  FOR EACH ROW EXECUTE FUNCTION assessment.guard_audio_incident_session();

CREATE FUNCTION assessment.guard_audio_incident_submission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound assessment.term_test_exam_session%ROWTYPE;
BEGIN
  IF NEW.listening_submitted_at IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.listening_submitted_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT s.* INTO bound FROM assessment.term_test_exam_session s
    WHERE (s.id=NEW.exam_session_id OR (NEW.exam_session_id IS NULL
      AND s.test_slug=NEW.test_slug AND s.definition_version=NEW.definition_version
      AND s.erp_course_class_id=NEW.erp_course_class_id AND s.erp_student_contact_id=NEW.erp_student_contact_id))
      AND s.superseded_at IS NULL
    ORDER BY s.prepared_at DESC LIMIT 1 FOR UPDATE;
  IF bound.listening_audio_protocol_version=1 AND bound.listening_audio_incident_id IS NOT NULL THEN
    RAISE EXCEPTION 'AUDIO_INCIDENT_OPEN' USING ERRCODE='P6701';
  END IF;
  IF bound.listening_audio_protocol_version=1 AND NEW.exam_session_id IS NULL THEN
    RAISE EXCEPTION 'AUDIO_SESSION_REQUIRED' USING ERRCODE='P6702';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER term_test_audio_hold_submission BEFORE INSERT OR UPDATE ON assessment.term_test_attempt
  FOR EACH ROW EXECUTE FUNCTION assessment.guard_audio_incident_submission();
