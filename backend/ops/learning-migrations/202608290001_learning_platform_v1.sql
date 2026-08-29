-- Dữ liệu nhận vào: lớp/học viên đã map trong schema mapping và form được backend kiểm bằng FormDefinitionV1.
-- Việc chính: tạo schema learning, tách public form khỏi đáp án riêng tư, lưu draft/final/evidence/queue có version.
-- Kết quả: Progress Log có nguồn dữ liệu chuẩn JSONB, Markdown chỉ là projection và mọi write giữ stable identity.
-- Khi lỗi: migration runner rollback toàn bộ transaction; production giữ nguyên version trước đó.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'learning_api') THEN
    CREATE ROLE learning_api NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS learning;

CREATE TABLE IF NOT EXISTS learning.taxonomy (
  code TEXT PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9_.-]{1,79}$'),
  category TEXT NOT NULL CHECK (category IN ('interaction', 'pedagogical_type', 'layout', 'skill')),
  label_vi TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'proposed', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learning.question_library (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9_.-]{1,79}$'),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('short_text', 'long_text', 'single_choice', 'multi_choice_group')),
  pedagogical_type_code TEXT NOT NULL,
  layout_type TEXT NOT NULL,
  grader_type TEXT NOT NULL CHECK (grader_type IN ('none', 'accepted_text', 'exact_option', 'unordered_group_slot', 'rubric_async')),
  default_config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(default_config) = 'object'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'proposed', 'retired')),
  created_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learning.form_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_key TEXT NOT NULL DEFAULT 'izone',
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reflection', 'mixed', 'quiz')),
  created_by_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learning.form_version (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES learning.form_template(id),
  version INTEGER NOT NULL CHECK (version > 0),
  schema_version TEXT NOT NULL DEFAULT 'FormDefinitionV1' CHECK (schema_version = 'FormDefinitionV1'),
  public_definition JSONB NOT NULL CHECK (jsonb_typeof(public_definition) = 'object'),
  definition_hash TEXT NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('draft', 'under_review', 'approved', 'published', 'retired')),
  created_by_email TEXT NOT NULL,
  approved_by_email TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version),
  UNIQUE (id, definition_hash),
  CONSTRAINT form_version_publish_check CHECK (
    (status <> 'published') OR (published_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS learning.form_grading_key (
  form_version_id UUID PRIMARY KEY REFERENCES learning.form_version(id),
  schema_version TEXT NOT NULL DEFAULT 'FormGradingKeyV1' CHECK (schema_version = 'FormGradingKeyV1'),
  grader_version INTEGER NOT NULL CHECK (grader_version > 0),
  private_definition JSONB NOT NULL CHECK (jsonb_typeof(private_definition) = 'object'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learning.asset (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_version_id UUID REFERENCES learning.form_version(id),
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('image', 'audio', 'passage', 'document')),
  storage_uri TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  mime_type TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public_form', 'attempt_only', 'internal')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (form_version_id, content_hash)
);

CREATE TABLE IF NOT EXISTS learning.form_assignment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_token UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  form_version_id UUID NOT NULL REFERENCES learning.form_version(id),
  organization_key TEXT NOT NULL DEFAULT 'izone',
  course_code TEXT,
  erp_course_class_id BIGINT NOT NULL,
  class_name_snapshot TEXT NOT NULL,
  session_number INTEGER NOT NULL CHECK (session_number BETWEEN 1 AND 100),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'closed', 'retired')),
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  created_by_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assignment_window_check CHECK (
    opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at
  )
);

CREATE TABLE IF NOT EXISTS learning.form_assignment_roster (
  assignment_id UUID NOT NULL REFERENCES learning.form_assignment(id),
  student_ref UUID NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  student_name_snapshot TEXT NOT NULL,
  display_discriminator TEXT NOT NULL DEFAULT '',
  roster_revision INTEGER NOT NULL DEFAULT 1 CHECK (roster_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, student_ref),
  UNIQUE (assignment_id, erp_student_contact_id)
);

CREATE TABLE IF NOT EXISTS learning.attempt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_token UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  assignment_id UUID NOT NULL REFERENCES learning.form_assignment(id),
  form_version_id UUID NOT NULL,
  definition_hash TEXT NOT NULL,
  student_ref UUID NOT NULL,
  client_idempotency_key UUID NOT NULL,
  identity_confirmation TEXT NOT NULL DEFAULT 'self_confirmed' CHECK (identity_confirmation = 'self_confirmed'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'submitted', 'superseded')),
  draft JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(draft) = 'object'),
  draft_hash TEXT NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  draft_revision BIGINT NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  draft_updated_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (form_version_id, definition_hash) REFERENCES learning.form_version(id, definition_hash),
  FOREIGN KEY (assignment_id, student_ref) REFERENCES learning.form_assignment_roster(assignment_id, student_ref),
  UNIQUE (assignment_id, student_ref, client_idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_learning_one_active_attempt
  ON learning.attempt (assignment_id, student_ref)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS learning.submission (
  id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL UNIQUE REFERENCES learning.attempt(id),
  assignment_id UUID NOT NULL REFERENCES learning.form_assignment(id),
  form_version_id UUID NOT NULL REFERENCES learning.form_version(id),
  student_ref UUID NOT NULL,
  source_revision INTEGER NOT NULL DEFAULT 1 CHECK (source_revision > 0),
  response_payload JSONB NOT NULL CHECK (jsonb_typeof(response_payload) = 'object'),
  response_hash TEXT NOT NULL CHECK (response_hash ~ '^[0-9a-f]{64}$'),
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'incomplete')),
  grading_status TEXT NOT NULL CHECK (grading_status IN ('complete', 'pending', 'manual_review')),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, student_ref),
  UNIQUE (attempt_id, response_hash)
);

CREATE TABLE IF NOT EXISTS learning.response_item (
  submission_id UUID NOT NULL REFERENCES learning.submission(id),
  item_version_id UUID NOT NULL,
  item_family_id UUID NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 100),
  interaction_type TEXT NOT NULL,
  pedagogical_type_code TEXT NOT NULL,
  skill_codes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skill_codes) = 'array'),
  response_value JSONB,
  answer_state TEXT NOT NULL CHECK (answer_state IN ('blank', 'answered', 'invalid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, item_version_id)
);

CREATE TABLE IF NOT EXISTS learning.grading_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES learning.submission(id),
  grader_version INTEGER NOT NULL CHECK (grader_version > 0),
  operation_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('complete', 'pending', 'manual_review', 'failed')),
  result_json JSONB NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id, grader_version)
);

CREATE TABLE IF NOT EXISTS learning.grading_result_item (
  grading_run_id UUID NOT NULL REFERENCES learning.grading_run(id),
  item_version_id UUID NOT NULL,
  raw_answer JSONB,
  normalized_answer JSONB,
  expected_answer JSONB,
  answer_state TEXT NOT NULL CHECK (answer_state IN ('blank', 'answered', 'invalid')),
  verdict TEXT NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'partial', 'pending', 'manual_review', 'ungraded')),
  score_earned NUMERIC(8, 3) NOT NULL DEFAULT 0,
  max_score NUMERIC(8, 3) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (grading_run_id, item_version_id)
);

CREATE TABLE IF NOT EXISTS learning.attendance_record (
  assignment_id UUID NOT NULL REFERENCES learning.form_assignment(id),
  student_ref UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('self_confirmed', 'pending_teacher', 'teacher_confirmed', 'not_eligible')),
  source_submission_id UUID REFERENCES learning.submission(id),
  current_reason TEXT NOT NULL DEFAULT '',
  decided_by_email TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, student_ref),
  FOREIGN KEY (assignment_id, student_ref) REFERENCES learning.form_assignment_roster(assignment_id, student_ref)
);

CREATE TABLE IF NOT EXISTS learning.attendance_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL,
  student_ref UUID NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  source_submission_id UUID,
  reason TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'teacher')),
  actor_email TEXT,
  operation_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (assignment_id, student_ref) REFERENCES learning.form_assignment_roster(assignment_id, student_ref)
);

CREATE TABLE IF NOT EXISTS learning.evidence_event (
  id UUID PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  entity_key TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  organization_key TEXT NOT NULL,
  course_code TEXT,
  erp_course_class_id BIGINT NOT NULL,
  session_number INTEGER NOT NULL,
  student_ref UUID NOT NULL,
  form_version_id UUID,
  assignment_id UUID,
  submission_id UUID,
  visibility TEXT NOT NULL CHECK (visibility IN ('internal', 'analysis_allowed', 'student_visible')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  renderer_version TEXT NOT NULL,
  markdown TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_system, source_record_id, source_revision)
);

CREATE TABLE IF NOT EXISTS learning.analysis_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_ref UUID NOT NULL,
  analysis_kind TEXT NOT NULL CHECK (analysis_kind IN ('after_session', 'periodic_report')),
  operation_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  prompt_version TEXT NOT NULL,
  model_name TEXT,
  input_manifest JSONB NOT NULL CHECK (jsonb_typeof(input_manifest) = 'object'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'complete', 'review_required', 'failed')),
  output_json JSONB,
  output_markdown TEXT,
  last_error_code TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learning.periodic_report (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_ref UUID NOT NULL,
  erp_course_class_id BIGINT NOT NULL,
  from_session_number INTEGER NOT NULL,
  to_session_number INTEGER NOT NULL,
  analysis_run_id UUID REFERENCES learning.analysis_run(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready_for_review', 'approved', 'published', 'superseded')),
  system_output JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(system_output) = 'object'),
  system_markdown TEXT NOT NULL DEFAULT '',
  approved_by_email TEXT,
  approved_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (to_session_number >= from_session_number)
);

CREATE TABLE IF NOT EXISTS learning.teacher_human_note (
  report_id UUID PRIMARY KEY REFERENCES learning.periodic_report(id),
  teacher_email TEXT NOT NULL,
  note_text TEXT NOT NULL CHECK (length(note_text) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learning.outbox_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL CHECK (job_type IN ('analyze_submission', 'build_periodic_report', 'refresh_dashboard', 'purge_student')),
  entity_key TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'retry_wait', 'complete', 'review_required', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  worker_id TEXT,
  leased_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  last_error_code TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learning.source_checkpoint (
  source_system TEXT PRIMARY KEY,
  cursor_value TEXT,
  source_revision TEXT,
  last_success_at TIMESTAMPTZ,
  last_error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_assignment_class_session
  ON learning.form_assignment (erp_course_class_id, session_number, status);
CREATE INDEX IF NOT EXISTS idx_learning_attempt_student
  ON learning.attempt (student_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_submission_assignment
  ON learning.submission (assignment_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_evidence_student_time
  ON learning.evidence_event (student_ref, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_evidence_class_session
  ON learning.evidence_event (erp_course_class_id, session_number, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_outbox_ready
  ON learning.outbox_job (status, next_attempt_at)
  WHERE status IN ('queued', 'retry_wait');
CREATE INDEX IF NOT EXISTS idx_learning_report_review
  ON learning.periodic_report (erp_course_class_id, status, updated_at DESC);

CREATE OR REPLACE VIEW learning.assignment_student_status AS
SELECT
  assignment.id AS assignment_id,
  assignment.erp_course_class_id,
  assignment.session_number,
  roster.student_ref,
  roster.student_name_snapshot,
  roster.display_discriminator,
  attempt.id AS attempt_id,
  attempt.status AS attempt_status,
  submission.id AS submission_id,
  submission.completeness,
  submission.grading_status,
  submission.submitted_at,
  attendance.status AS attendance_status,
  attendance.current_reason AS attendance_reason,
  attendance.decided_by_email
FROM learning.form_assignment AS assignment
JOIN learning.form_assignment_roster AS roster ON roster.assignment_id = assignment.id
LEFT JOIN learning.attempt AS attempt
  ON attempt.assignment_id = assignment.id
  AND attempt.student_ref = roster.student_ref
  AND attempt.status <> 'superseded'
LEFT JOIN learning.submission AS submission ON submission.attempt_id = attempt.id
LEFT JOIN learning.attendance_record AS attendance
  ON attendance.assignment_id = assignment.id
  AND attendance.student_ref = roster.student_ref;

INSERT INTO learning.taxonomy (code, category, label_vi)
VALUES
  ('reflection', 'pedagogical_type', 'Tự phản tư'),
  ('short_answer', 'pedagogical_type', 'Trả lời ngắn'),
  ('form_completion', 'pedagogical_type', 'Điền biểu mẫu'),
  ('note_completion', 'pedagogical_type', 'Điền ghi chú'),
  ('table_completion', 'pedagogical_type', 'Điền bảng'),
  ('sentence_completion', 'pedagogical_type', 'Hoàn thành câu'),
  ('summary_completion', 'pedagogical_type', 'Hoàn thành tóm tắt'),
  ('multiple_choice', 'pedagogical_type', 'Trắc nghiệm'),
  ('matching_headings', 'pedagogical_type', 'Nối tiêu đề'),
  ('matching_features', 'pedagogical_type', 'Nối đặc điểm'),
  ('matching_information', 'pedagogical_type', 'Nối thông tin'),
  ('true_false_not_given', 'pedagogical_type', 'TRUE/FALSE/NOT GIVEN'),
  ('yes_no_not_given', 'pedagogical_type', 'YES/NO/NOT GIVEN'),
  ('map_labelling', 'pedagogical_type', 'Gắn nhãn bản đồ'),
  ('writing_task_1', 'pedagogical_type', 'Writing Task 1'),
  ('writing_task_2', 'pedagogical_type', 'Writing Task 2')
ON CONFLICT (code) DO NOTHING;

INSERT INTO learning.question_library (
  id, code, title, prompt, interaction_type, pedagogical_type_code, layout_type, grader_type, default_config
)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'reflection.achievement', 'Điều đã làm được', 'Sau phần vừa học, em đã làm được điều gì?', 'long_text', 'reflection', 'plain_prompt', 'none', '{"required":true,"maxLength":600}'::jsonb),
  ('10000000-0000-4000-8000-000000000002', 'reflection.difficulty', 'Điểm còn vướng', 'Điều gì vẫn khiến em chưa chắc hoặc còn vướng?', 'long_text', 'reflection', 'plain_prompt', 'none', '{"required":true,"maxLength":600}'::jsonb),
  ('10000000-0000-4000-8000-000000000003', 'reflection.next_action', 'Việc tiếp theo', 'Việc cụ thể tiếp theo em sẽ làm là gì?', 'short_text', 'reflection', 'plain_prompt', 'none', '{"required":true,"maxLength":300}'::jsonb),
  ('10000000-0000-4000-8000-000000000004', 'reflection.accuracy', 'Kết quả luyện tập', 'Em làm đúng hoặc hoàn thành được bao nhiêu câu?', 'short_text', 'reflection', 'plain_prompt', 'none', '{"required":true,"maxLength":120}'::jsonb),
  ('10000000-0000-4000-8000-000000000005', 'reflection.teacher_support', 'Điều cần hỗ trợ', 'Em muốn giảng viên hỗ trợ thêm điều gì?', 'long_text', 'reflection', 'plain_prompt', 'none', '{"required":false,"maxLength":600}'::jsonb),
  ('10000000-0000-4000-8000-000000000006', 'reflection.confidence', 'Mức độ tự tin', 'Sau phần này, em tự tin nhất ở điểm nào?', 'short_text', 'reflection', 'plain_prompt', 'none', '{"required":true,"maxLength":300}'::jsonb)
ON CONFLICT (id) DO NOTHING;

GRANT USAGE ON SCHEMA learning TO learning_api;
GRANT SELECT ON
  learning.taxonomy,
  learning.question_library,
  learning.form_template,
  learning.form_version,
  learning.form_assignment,
  learning.form_assignment_roster,
  learning.attempt,
  learning.submission,
  learning.response_item,
  learning.grading_run,
  learning.grading_result_item,
  learning.attendance_record,
  learning.attendance_event,
  learning.evidence_event,
  learning.analysis_run,
  learning.periodic_report,
  learning.teacher_human_note,
  learning.outbox_job,
  learning.source_checkpoint,
  learning.asset,
  learning.assignment_student_status
TO learning_api;

GRANT INSERT ON
  learning.form_template,
  learning.form_version,
  learning.form_grading_key,
  learning.form_assignment,
  learning.form_assignment_roster,
  learning.attempt,
  learning.submission,
  learning.response_item,
  learning.grading_run,
  learning.grading_result_item,
  learning.attendance_record,
  learning.attendance_event,
  learning.evidence_event,
  learning.analysis_run,
  learning.periodic_report,
  learning.teacher_human_note,
  learning.outbox_job,
  learning.source_checkpoint,
  learning.asset
TO learning_api;

GRANT UPDATE ON
  learning.attempt,
  learning.attendance_record,
  learning.analysis_run,
  learning.periodic_report,
  learning.teacher_human_note,
  learning.outbox_job,
  learning.source_checkpoint
TO learning_api;

GRANT SELECT ON learning.form_grading_key TO learning_api;
GRANT SELECT ON
  mapping.classroom_course_mapping,
  mapping.student_mapping_review,
  mapping.erp_class_membership_snapshot,
  mapping.reviewer_class_access
TO learning_api;
