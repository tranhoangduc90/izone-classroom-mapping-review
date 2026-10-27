-- Additive audit only. Never rewrites exam/session/draft/grade rows.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE assessment.term_test_audio_owner_recovery (
 request_id uuid PRIMARY KEY,
 exam_session_id uuid NOT NULL REFERENCES assessment.term_test_exam_session(id) ON DELETE CASCADE,
 request_hash text NOT NULL,
 actor_email text NOT NULL,
 action text NOT NULL CHECK(action IN ('release-preparation','transfer-active')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 500),
 before_version text NOT NULL,
 after_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
GRANT SELECT,INSERT ON assessment.term_test_audio_owner_recovery TO k67_app;
COMMIT;
