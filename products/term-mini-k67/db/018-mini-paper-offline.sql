BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TABLE IF NOT EXISTS assessment.mini_k67_paper_offline_run (
    session_id uuid PRIMARY KEY REFERENCES assessment.term_test_exam_session(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL,
    student_ref uuid NOT NULL,
    generation bigint NOT NULL CHECK (generation >= 0),
    prepared_at timestamptz NOT NULL DEFAULT now(),
    state jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS assessment.mini_k67_paper_offline_operation (
    operation_id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES assessment.mini_k67_paper_offline_run(session_id) ON DELETE CASCADE,
    payload_hash text NOT NULL,
    receipt jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS mini_k67_paper_offline_operation_session
    ON assessment.mini_k67_paper_offline_operation(session_id);
GRANT SELECT, INSERT, UPDATE ON assessment.mini_k67_paper_offline_run,
    assessment.mini_k67_paper_offline_operation TO k67_app;
COMMIT;
