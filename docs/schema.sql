-- Bản phác thảo PostgreSQL cho dữ liệu tích hợp.
-- Chỉ lưu khóa kỹ thuật và snapshot tối thiểu; không đặt credential trong repo.

CREATE TABLE class_mapping (
  id BIGSERIAL PRIMARY KEY,
  erp_course_class_id BIGINT NOT NULL UNIQUE,
  classroom_course_id TEXT NOT NULL UNIQUE,
  erp_class_name_snapshot TEXT,
  classroom_course_name_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('pending_review', 'approved', 'inactive', 'conflict')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE student_identity_mapping (
  id BIGSERIAL PRIMARY KEY,
  erp_student_contact_id BIGINT NOT NULL,
  google_user_id TEXT NOT NULL,
  google_email_snapshot TEXT,
  erp_name_snapshot TEXT,
  google_name_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('approved', 'inactive', 'conflict')),
  match_method TEXT NOT NULL
    CHECK (match_method IN ('email', 'google_id', 'ai_suggested', 'teacher_confirmed', 'manual')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_active_erp_student UNIQUE (erp_student_contact_id),
  CONSTRAINT uq_active_google_user UNIQUE (google_user_id)
);

CREATE TABLE mapping_review_queue (
  id BIGSERIAL PRIMARY KEY,
  erp_course_class_id BIGINT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  google_course_id TEXT,
  google_user_id TEXT NOT NULL,
  erp_name_snapshot TEXT,
  google_name_snapshot TEXT,
  google_email_snapshot TEXT,
  ai_score NUMERIC(5, 4) CHECK (ai_score >= 0 AND ai_score <= 1),
  ai_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected', 'superseded')),
  reviewer_email TEXT,
  reviewer_note TEXT,
  decided_at TIMESTAMPTZ,
  source_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_review_queue_class_status
  ON mapping_review_queue (erp_course_class_id, status);

CREATE TABLE mapping_decision_event (
  id BIGSERIAL PRIMARY KEY,
  review_id BIGINT NOT NULL REFERENCES mapping_review_queue(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'choose_another')),
  selected_google_user_id TEXT,
  reviewer_email TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Các workflow khác nên đọc qua view này để chỉ lấy mapping đã được duyệt.
CREATE VIEW approved_student_classroom_mapping AS
SELECT
  sim.erp_student_contact_id,
  sim.google_user_id,
  sim.google_email_snapshot,
  sim.erp_name_snapshot,
  sim.google_name_snapshot,
  sim.approved_at
FROM student_identity_mapping sim
WHERE sim.status = 'approved';
