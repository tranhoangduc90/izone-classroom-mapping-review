-- Dữ liệu nhận vào: schema learning V1 và các form đã phát hành.
-- Việc chính: bổ sung checkpoint, quyền mở từng phần, kỹ năng thư viện, insight cấp lớp và lịch sử gửi báo cáo.
-- Kết quả: demo và sản phẩm dùng cùng một nguồn dữ liệu thật; mọi thao tác quan trọng có identity/idempotency để truy vết.
-- Khi lỗi: migration runner rollback toàn bộ transaction; không ghi dở dang một phần V2.

ALTER TABLE learning.question_library
  DROP CONSTRAINT IF EXISTS question_library_interaction_type_check;
ALTER TABLE learning.question_library
  ADD CONSTRAINT question_library_interaction_type_check
  CHECK (interaction_type IN ('short_text', 'long_text', 'single_choice', 'multi_choice_group', 'number_score'));

ALTER TABLE learning.question_library
  ADD COLUMN IF NOT EXISTS sharing_scope TEXT NOT NULL DEFAULT 'center'
    CHECK (sharing_scope IN ('center', 'creator', 'class')),
  ADD COLUMN IF NOT EXISTS approved_by_email TEXT;

CREATE TABLE IF NOT EXISTS learning.question_library_skill (
  question_library_id UUID NOT NULL REFERENCES learning.question_library(id),
  skill_code TEXT NOT NULL REFERENCES learning.taxonomy(code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_library_id, skill_code)
);

CREATE TABLE IF NOT EXISTS learning.assignment_block_release (
  assignment_id UUID NOT NULL REFERENCES learning.form_assignment(id),
  block_id UUID NOT NULL,
  checkpoint INTEGER NOT NULL CHECK (checkpoint BETWEEN 1 AND 20),
  status TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('locked', 'open', 'closed')),
  release_version BIGINT NOT NULL DEFAULT 1 CHECK (release_version > 0),
  updated_by_email TEXT NOT NULL,
  released_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, block_id)
);

CREATE TABLE IF NOT EXISTS learning.assignment_block_release_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES learning.form_assignment(id),
  block_id UUID NOT NULL,
  checkpoint INTEGER NOT NULL CHECK (checkpoint BETWEEN 1 AND 20),
  previous_status TEXT CHECK (previous_status IN ('locked', 'open', 'closed')),
  new_status TEXT NOT NULL CHECK (new_status IN ('locked', 'open', 'closed')),
  release_version BIGINT NOT NULL CHECK (release_version > 0),
  actor_email TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO learning.assignment_block_release (
  assignment_id, block_id, checkpoint, status, release_version, updated_by_email, released_at
)
SELECT
  assignment.id,
  (block ->> 'blockId')::uuid,
  (block ->> 'checkpoint')::integer,
  CASE WHEN (block ->> 'checkpoint')::integer = 1 THEN 'open' ELSE 'locked' END,
  1,
  assignment.created_by_email,
  CASE WHEN (block ->> 'checkpoint')::integer = 1 THEN now() ELSE NULL END
FROM learning.form_assignment AS assignment
JOIN learning.form_version AS version ON version.id = assignment.form_version_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(version.public_definition -> 'blocks', '[]'::jsonb)) AS block
WHERE assignment.status IN ('published', 'closed')
ON CONFLICT (assignment_id, block_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS learning.checkpoint_submission (
  id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL REFERENCES learning.attempt(id),
  assignment_id UUID NOT NULL REFERENCES learning.form_assignment(id),
  form_version_id UUID NOT NULL REFERENCES learning.form_version(id),
  student_ref UUID NOT NULL,
  block_id UUID NOT NULL,
  checkpoint INTEGER NOT NULL CHECK (checkpoint BETWEEN 1 AND 20),
  checkpoint_revision INTEGER NOT NULL DEFAULT 1 CHECK (checkpoint_revision > 0),
  response_payload JSONB NOT NULL CHECK (jsonb_typeof(response_payload) = 'object'),
  response_hash TEXT NOT NULL CHECK (response_hash ~ '^[0-9a-f]{64}$'),
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'incomplete')),
  missing_item_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(missing_item_version_ids) = 'array'),
  operation_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, block_id, checkpoint_revision),
  FOREIGN KEY (assignment_id, student_ref)
    REFERENCES learning.form_assignment_roster(assignment_id, student_ref)
);

CREATE TABLE IF NOT EXISTS learning.class_session_insight (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES learning.form_assignment(id),
  insight_version INTEGER NOT NULL CHECK (insight_version > 0),
  category TEXT NOT NULL CHECK (category IN ('strength', 'recurring_issue', 'needs_attention', 'next_action')),
  skill_code TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  affected_student_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(affected_student_refs) = 'array'),
  evidence_manifest JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence_manifest) = 'object'),
  status TEXT NOT NULL DEFAULT 'ready_for_review' CHECK (status IN ('draft', 'ready_for_review', 'approved', 'superseded')),
  entity_key TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, insight_version, category, title)
);

ALTER TABLE learning.periodic_report
  ADD COLUMN IF NOT EXISTS report_kind TEXT NOT NULL DEFAULT 'periodic'
    CHECK (report_kind IN ('after_session', 'periodic')),
  ADD COLUMN IF NOT EXISTS assignment_id UUID REFERENCES learning.form_assignment(id);

CREATE TABLE IF NOT EXISTS learning.report_delivery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES learning.periodic_report(id),
  student_ref UUID NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('manual', 'portal', 'email')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  provider_message_id TEXT,
  operation_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  sent_by_email TEXT,
  attempted_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (report_id, channel, idempotency_key)
);

ALTER TABLE learning.outbox_job
  DROP CONSTRAINT IF EXISTS outbox_job_job_type_check;
ALTER TABLE learning.outbox_job
  ADD CONSTRAINT outbox_job_job_type_check
  CHECK (job_type IN (
    'analyze_submission',
    'grade_translation',
    'grade_writing_speaking',
    'build_periodic_report',
    'refresh_dashboard',
    'purge_student',
    'deliver_report'
  ));

INSERT INTO learning.taxonomy (code, category, label_vi)
VALUES
  ('listening', 'skill', 'Listening'),
  ('reading', 'skill', 'Reading'),
  ('writing', 'skill', 'Writing'),
  ('speaking', 'skill', 'Speaking')
ON CONFLICT (code) DO NOTHING;

UPDATE learning.question_library
SET approved_by_email = COALESCE(approved_by_email, created_by_email, 'system@izone.edu.vn')
WHERE sharing_scope = 'center';

UPDATE learning.question_library
SET interaction_type = 'number_score',
    default_config = '{"required":true,"interactionConfig":{"min":0,"max":10,"step":1,"unit":"câu đúng"}}'::jsonb,
    updated_at = now()
WHERE code = 'reflection.accuracy';

INSERT INTO learning.question_library (
  id, code, title, prompt, interaction_type, pedagogical_type_code, layout_type,
  grader_type, default_config, sharing_scope, approved_by_email
)
VALUES
  ('10000000-0000-4000-8000-000000000007', 'reflection.remembered_knowledge',
   'Điều em nhớ được', 'Sau phần vừa học, em nhớ rõ nhất điều gì?', 'single_choice',
   'reflection', 'plain_prompt', 'none',
   '{"required":true,"options":[{"id":"main_idea","label":"Cách tìm ý chính"},{"id":"keyword","label":"Cách dùng từ khóa"},{"id":"elimination","label":"Cách loại phương án nhiễu"}]}'::jsonb,
   'center', 'system@izone.edu.vn'),
  ('10000000-0000-4000-8000-000000000008', 'reflection.student_reported_teacher_feedback',
   'Điều em nghe từ giảng viên', 'Em ghi lại ngắn gọn điều giảng viên vừa nhận xét hoặc dặn em.',
   'short_text', 'reflection', 'plain_prompt', 'none',
   '{"required":false,"maxLength":500,"evidenceSource":"student_reported_teacher_feedback"}'::jsonb,
   'center', 'system@izone.edu.vn')
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning.question_library_skill (question_library_id, skill_code)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'listening'),
  ('10000000-0000-4000-8000-000000000001', 'reading'),
  ('10000000-0000-4000-8000-000000000001', 'writing'),
  ('10000000-0000-4000-8000-000000000001', 'speaking'),
  ('10000000-0000-4000-8000-000000000002', 'listening'),
  ('10000000-0000-4000-8000-000000000002', 'reading'),
  ('10000000-0000-4000-8000-000000000002', 'writing'),
  ('10000000-0000-4000-8000-000000000002', 'speaking'),
  ('10000000-0000-4000-8000-000000000003', 'listening'),
  ('10000000-0000-4000-8000-000000000003', 'reading'),
  ('10000000-0000-4000-8000-000000000003', 'writing'),
  ('10000000-0000-4000-8000-000000000003', 'speaking'),
  ('10000000-0000-4000-8000-000000000004', 'listening'),
  ('10000000-0000-4000-8000-000000000005', 'listening'),
  ('10000000-0000-4000-8000-000000000005', 'reading'),
  ('10000000-0000-4000-8000-000000000005', 'writing'),
  ('10000000-0000-4000-8000-000000000005', 'speaking'),
  ('10000000-0000-4000-8000-000000000006', 'listening'),
  ('10000000-0000-4000-8000-000000000006', 'reading'),
  ('10000000-0000-4000-8000-000000000006', 'writing'),
  ('10000000-0000-4000-8000-000000000006', 'speaking'),
  ('10000000-0000-4000-8000-000000000007', 'reading'),
  ('10000000-0000-4000-8000-000000000008', 'listening'),
  ('10000000-0000-4000-8000-000000000008', 'reading'),
  ('10000000-0000-4000-8000-000000000008', 'writing'),
  ('10000000-0000-4000-8000-000000000008', 'speaking')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION learning.enforce_scored_form_second_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_scored_item BOOLEAN;
BEGIN
  IF NEW.status <> 'published' THEN
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(NEW.public_definition -> 'blocks', '[]'::jsonb)) AS block,
         jsonb_array_elements(COALESCE(block -> 'items', '[]'::jsonb)) AS item
    WHERE COALESCE((item ->> 'maxScore')::numeric, 0) > 0
       OR COALESCE(item ->> 'graderType', 'none') <> 'none'
  ) INTO has_scored_item;
  IF has_scored_item AND (NEW.approved_by_email IS NULL OR NEW.approved_by_email = NEW.created_by_email) THEN
    RAISE EXCEPTION 'FORM_SECOND_APPROVAL_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_learning_scored_form_second_approval ON learning.form_version;
CREATE TRIGGER trg_learning_scored_form_second_approval
BEFORE INSERT OR UPDATE OF status, public_definition, approved_by_email
ON learning.form_version
FOR EACH ROW
EXECUTE FUNCTION learning.enforce_scored_form_second_approval();

CREATE INDEX IF NOT EXISTS idx_learning_checkpoint_attempt
  ON learning.checkpoint_submission (attempt_id, checkpoint, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_block_release_assignment
  ON learning.assignment_block_release (assignment_id, checkpoint);
CREATE INDEX IF NOT EXISTS idx_learning_class_insight_assignment
  ON learning.class_session_insight (assignment_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_report_delivery_report
  ON learning.report_delivery (report_id, status, updated_at DESC);

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
LEFT JOIN LATERAL (
  SELECT candidate.*
  FROM learning.attempt AS candidate
  WHERE candidate.assignment_id = assignment.id
    AND candidate.student_ref = roster.student_ref
    AND candidate.status <> 'superseded'
  ORDER BY candidate.created_at DESC, candidate.id DESC
  LIMIT 1
) AS attempt ON true
LEFT JOIN learning.submission AS submission ON submission.attempt_id = attempt.id
LEFT JOIN learning.attendance_record AS attendance
  ON attendance.assignment_id = assignment.id
  AND attendance.student_ref = roster.student_ref;

GRANT SELECT ON
  learning.question_library_skill,
  learning.assignment_block_release,
  learning.assignment_block_release_event,
  learning.checkpoint_submission,
  learning.class_session_insight,
  learning.report_delivery
TO learning_api;

GRANT INSERT ON
  learning.question_library_skill,
  learning.assignment_block_release,
  learning.assignment_block_release_event,
  learning.checkpoint_submission,
  learning.class_session_insight,
  learning.report_delivery
TO learning_api;

GRANT UPDATE ON
  learning.assignment_block_release,
  learning.class_session_insight,
  learning.report_delivery
TO learning_api;
