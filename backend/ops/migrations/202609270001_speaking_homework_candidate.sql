-- Bản ứng viên để kiểm thử trong API. Chưa áp dụng lên mapping_db production.
-- Khi Issue của repository mapping được mở, chuyển migration này sang kho chuẩn và rà quyền role.
CREATE SCHEMA IF NOT EXISTS speaking_homework;

CREATE TABLE speaking_homework.assignment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id BIGINT NOT NULL,
  course_id TEXT NOT NULL,
  course_work_id TEXT NOT NULL,
  assignment_code TEXT NOT NULL,
  doctor_course_key TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  opened_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, course_work_id),
  UNIQUE (course_id, assignment_code)
);

CREATE TABLE speaking_homework.assignment_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES speaking_homework.assignment(id),
  document_id TEXT NOT NULL UNIQUE,
  student_ref UUID,
  status_cell_anchor TEXT NOT NULL DEFAULT 'TÌNH TRẠNG NỘP BÀI SPEAKING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE speaking_homework.assignment_part (
  assignment_id UUID NOT NULL REFERENCES speaking_homework.assignment(id),
  part_key TEXT NOT NULL CHECK (part_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  display_title TEXT NOT NULL,
  practice_url TEXT NOT NULL,
  min_questions INTEGER NOT NULL CHECK (min_questions BETWEEN 1 AND 100),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 20),
  PRIMARY KEY (assignment_id, part_key),
  UNIQUE (assignment_id, position)
);

CREATE TABLE speaking_homework.access_grant (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES speaking_homework.assignment(id),
  student_ref UUID NOT NULL,
  document_id TEXT NOT NULL REFERENCES speaking_homework.assignment_document(document_id),
  token_hash CHAR(64) NOT NULL UNIQUE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, student_ref, document_id)
);

CREATE TABLE speaking_homework.submission (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_grant_id UUID NOT NULL UNIQUE REFERENCES speaking_homework.access_grant(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE speaking_homework.submission_link (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES speaking_homework.submission(id),
  part TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  share_url TEXT NOT NULL,
  share_id TEXT NOT NULL,
  fingerprint CHAR(64),
  check_status TEXT NOT NULL DEFAULT 'pending' CHECK (check_status IN ('pending', 'accepted', 'rejected')),
  check_code TEXT,
  question_count INTEGER CHECK (question_count >= 0),
  typing_warning JSONB,
  voice_confirmed BOOLEAN NOT NULL DEFAULT false,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at TIMESTAMPTZ,
  UNIQUE (submission_id, part, revision)
);
CREATE INDEX submission_link_latest_idx ON speaking_homework.submission_link(submission_id, part, revision DESC);

CREATE TABLE speaking_homework.check_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL UNIQUE REFERENCES speaking_homework.submission_link(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX check_job_queue_idx ON speaking_homework.check_job(created_at) WHERE status IN ('pending', 'failed');

CREATE TABLE speaking_homework.conversation_claim (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('homework', 'practice')),
  source_id UUID NOT NULL,
  assignment_id UUID NOT NULL REFERENCES speaking_homework.assignment(id),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, share_id),
  UNIQUE (course_id, fingerprint),
  UNIQUE (source_kind, source_id)
);

CREATE TABLE speaking_homework.receipt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL UNIQUE REFERENCES speaking_homework.submission(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, submission_id)
);
CREATE TABLE speaking_homework.outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES speaking_homework.receipt(id),
  kind TEXT NOT NULL CHECK (kind IN ('write_doc', 'grade_speaking', 'doctor_analyze')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  external_receipt TEXT,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (receipt_id, kind)
);

CREATE TABLE speaking_homework.doctor_exercise (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_key TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  title TEXT NOT NULL,
  exercise_url TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (course_key, source_record_id)
);
CREATE TABLE speaking_homework.doctor_recommendation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id BIGINT NOT NULL,
  student_ref UUID NOT NULL,
  exercise_id UUID NOT NULL REFERENCES speaking_homework.doctor_exercise(id),
  recommendation_count INTEGER NOT NULL DEFAULT 0 CHECK (recommendation_count >= 0),
  practice_count INTEGER NOT NULL DEFAULT 0 CHECK (practice_count >= 0),
  waiting BOOLEAN NOT NULL DEFAULT false,
  proposed_at TIMESTAMPTZ,
  last_practiced_at TIMESTAMPTZ,
  UNIQUE (class_id, student_ref, exercise_id)
);
CREATE TABLE speaking_homework.doctor_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key TEXT NOT NULL UNIQUE,
  recommendation_id UUID NOT NULL REFERENCES speaking_homework.doctor_recommendation(id),
  kind TEXT NOT NULL CHECK (kind IN ('recommendation', 'practice')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE speaking_homework.practice_link (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_grant_id UUID NOT NULL REFERENCES speaking_homework.access_grant(id),
  slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  share_url TEXT NOT NULL,
  share_id TEXT NOT NULL,
  fingerprint CHAR(64),
  exercise_id UUID REFERENCES speaking_homework.doctor_exercise(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'needs_voice_confirmation', 'accepted', 'rejected')),
  check_code TEXT,
  question_count INTEGER CHECK (question_count >= 0),
  typing_warning JSONB,
  voice_confirmed BOOLEAN NOT NULL DEFAULT false,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at TIMESTAMPTZ,
  UNIQUE (access_grant_id, slot, revision)
);
CREATE INDEX practice_link_latest_idx ON speaking_homework.practice_link(access_grant_id, slot, revision DESC);
CREATE TABLE speaking_homework.practice_check_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_link_id UUID NOT NULL UNIQUE REFERENCES speaking_homework.practice_link(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON SCHEMA speaking_homework IS 'Bài nộp Speaking và danh sách Bác sĩ AI của học viên; bản ứng viên IC2304.';
