-- Sổ chống ghi lặp chỉ dành cho khôi phục audio K67; không cập nhật bài cũ.
CREATE TABLE assessment.term_test_audio_recovery_event (
  exam_session_id uuid NOT NULL REFERENCES assessment.term_test_exam_session(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  playback_state text NOT NULL CHECK (playback_state IN ('pause','waiting','stalled','pagehide','recovered','resume')),
  heard_seconds double precision NOT NULL CHECK (heard_seconds >= 0 AND heard_seconds <= 7200),
  granted_seconds integer NOT NULL CHECK (granted_seconds >= 0 AND granted_seconds <= 900),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (exam_session_id, event_id)
);
GRANT SELECT, INSERT ON assessment.term_test_audio_recovery_event TO k67_app;
