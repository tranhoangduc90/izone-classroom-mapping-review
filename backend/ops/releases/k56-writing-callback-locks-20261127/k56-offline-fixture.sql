ALTER TABLE assessment.test_definition DROP CONSTRAINT test_definition_slug_check;
ALTER TABLE assessment.test_definition ADD CONSTRAINT test_definition_slug_check
  CHECK (slug ~ '^(term-test-[1-9][0-9]*(-k56)?|mini-test-[a-z0-9-]+)$');
ALTER TABLE assessment.term_test_attempt ADD COLUMN IF NOT EXISTS attempt_mode text DEFAULT 'cbt';
ALTER TABLE assessment.term_test_attempt ADD COLUMN IF NOT EXISTS generation bigint DEFAULT 1;
ALTER TABLE assessment.term_test_exam_session ADD COLUMN IF NOT EXISTS generation bigint DEFAULT 1;
CREATE TABLE IF NOT EXISTS assessment.term1_skill_grant (
  id uuid PRIMARY KEY,
  secret_hash text NOT NULL UNIQUE,
  activation_hash text NOT NULL,
  attempt_id uuid NOT NULL REFERENCES assessment.term_test_attempt(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  class_id bigint NOT NULL CHECK (class_id > 0),
  student_ref uuid NOT NULL,
  section text NOT NULL CHECK (section IN ('listening', 'reading', 'writing')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  owner_id uuid,
  bound_at timestamptz,
  revoked_at timestamptz,
  CHECK ((owner_id IS NULL) = (bound_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS term1_skill_grant_one_active
  ON assessment.term1_skill_grant(attempt_id, generation, section)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS assessment.term1_offline_run (
 attempt_id uuid PRIMARY KEY REFERENCES assessment.term_test_attempt(id) ON DELETE CASCADE,
 session_id uuid NOT NULL, generation bigint NOT NULL, owner_id uuid NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT now(), policy text NOT NULL,
 state jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS assessment.term1_offline_operation (
 operation_id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES assessment.term1_offline_run(attempt_id) ON DELETE CASCADE,
 payload_hash text NOT NULL, section text NOT NULL, kind text NOT NULL,
 payload jsonb NOT NULL, receipt jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS term1_offline_operations_attempt ON assessment.term1_offline_operation(attempt_id,committed_at);
CREATE INDEX IF NOT EXISTS term1_offline_writing_pending ON assessment.term1_offline_operation(attempt_id)
 WHERE section='writing' AND kind='seal' AND receipt->>'status'='accepted';
ALTER TABLE assessment.term1_offline_run ADD COLUMN IF NOT EXISTS main_owner_pending boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS assessment.term2_offline_run (
 attempt_id uuid PRIMARY KEY REFERENCES assessment.term_test_attempt(id) ON DELETE CASCADE,
 session_id uuid NOT NULL, generation bigint NOT NULL, owner_id uuid NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT now(), policy text NOT NULL,
 state jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS assessment.term2_offline_operation (
 operation_id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES assessment.term2_offline_run(attempt_id) ON DELETE CASCADE,
 payload_hash text NOT NULL, section text NOT NULL, kind text NOT NULL,
 payload jsonb NOT NULL, receipt jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS term2_offline_operations_attempt ON assessment.term2_offline_operation(attempt_id,committed_at);
CREATE INDEX IF NOT EXISTS term2_offline_writing_pending ON assessment.term2_offline_operation(attempt_id)
 WHERE section='writing' AND kind='seal' AND receipt->>'status'='accepted';

CREATE TABLE IF NOT EXISTS assessment.mini_k56_offline_run (
 attempt_id uuid PRIMARY KEY REFERENCES assessment.term_test_attempt(id) ON DELETE CASCADE,
 session_id uuid NOT NULL, generation bigint NOT NULL, owner_id uuid NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT now(), policy text NOT NULL,
 state jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS assessment.mini_k56_offline_operation (
 operation_id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES assessment.mini_k56_offline_run(attempt_id) ON DELETE CASCADE,
 payload_hash text NOT NULL, section text NOT NULL, kind text NOT NULL,
 payload jsonb NOT NULL, receipt jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mini_k56_offline_operations_attempt ON assessment.mini_k56_offline_operation(attempt_id,committed_at);
CREATE INDEX IF NOT EXISTS mini_k56_offline_writing_pending ON assessment.mini_k56_offline_operation(attempt_id)
 WHERE section='writing' AND kind='seal' AND receipt->>'status'='accepted';

GRANT SELECT,INSERT,UPDATE ON assessment.term1_skill_grant, assessment.term1_offline_run, assessment.term1_offline_operation, assessment.term2_offline_run, assessment.term2_offline_operation, assessment.mini_k56_offline_run, assessment.mini_k56_offline_operation TO k67_app;

-- A product owns this schema in its own native PostgreSQL database.
-- No Portal calls in the enqueue transaction. No import/replay of historical results.
CREATE SCHEMA IF NOT EXISTS portal_exam;
CREATE TABLE IF NOT EXISTS portal_exam.source_event(
 id uuid PRIMARY KEY,event_key text NOT NULL,revision bigint GENERATED ALWAYS AS IDENTITY,
 family text NOT NULL CHECK(family IN('k67','k56','legacy','writing')),attempt_id uuid NOT NULL,
 field text NOT NULL CHECK(field IN('listening','reading','writing','mini')),
 grade_hash text NOT NULL,intent jsonb NOT NULL,hub_payload jsonb NOT NULL,
 payload_hash text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','accepted','complete','blocked','unknown')),
 hub_request_id uuid,hub_state text,error_code text,attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),lease_id uuid,lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(event_key,grade_hash),UNIQUE(event_key,revision));
CREATE INDEX IF NOT EXISTS source_event_pending_idx ON portal_exam.source_event(available_at) WHERE state IN('queued','accepted');
CREATE TABLE IF NOT EXISTS portal_exam.transport_control(id integer PRIMARY KEY CHECK(id=1),hold_until timestamptz NOT NULL DEFAULT '-infinity',failures integer NOT NULL DEFAULT 0);
INSERT INTO portal_exam.transport_control(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS portal_exam.capture_control(id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,writes_enabled boolean NOT NULL DEFAULT false,cutover_at timestamptz);
INSERT INTO portal_exam.capture_control(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS portal_exam.native_dirty(
 attempt_id uuid PRIMARY KEY,fields text[] NOT NULL,revision bigint NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','blocked')),error_code text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp());

UPDATE portal_exam.capture_control SET enabled=true,cutover_at='2026-11-01T00:00:00Z' WHERE id=1;
GRANT USAGE ON SCHEMA portal_exam TO k67_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA portal_exam TO k67_app;
CREATE SCHEMA assessment_k56;
CREATE VIEW assessment_k56.term_test_attempt AS SELECT * FROM assessment.term_test_attempt;
CREATE VIEW assessment_k56.term_test_writing_grading_final AS SELECT * FROM assessment.term_test_writing_grading_final;
CREATE VIEW assessment_k56.test_definition AS SELECT * FROM assessment.test_definition;
CREATE TABLE assessment_k56.term_test_roster(test_slug text,erp_course_class_id bigint,erp_student_contact_id bigint,is_eligible boolean);
CREATE TABLE assessment_k56.term_test_class_access(test_slug text,erp_course_class_id bigint,enabled boolean);
CREATE TABLE assessment_k56.term_test_portal_sync_state(attempt_id uuid,grade_fields text[]);
CREATE TABLE assessment_k56.k56_portal_field_dispatch(attempt_id uuid,field text,grade numeric,status text,PRIMARY KEY(attempt_id,field));
GRANT USAGE ON SCHEMA assessment_k56 TO k67_app;
GRANT SELECT ON ALL TABLES IN SCHEMA assessment_k56 TO k67_app;
GRANT INSERT ON assessment_k56.k56_portal_field_dispatch TO k67_app;
