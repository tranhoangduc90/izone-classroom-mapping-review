-- Đầu vào: catalogue Speaking đang chạy; các bài trước Lesson 6 giữ nguyên.
-- Việc chính: thêm kho bài làm độc lập, hồ sơ Docs/nguồn, hàng kiểm và Doctor.
-- Kết quả: bài mới có thể nhận trên web trước Classroom; lỗi hoàn tác transaction.
BEGIN;
SET LOCAL application_name = 'mapping-git:speaking-independent-lesson6';
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));
CREATE SCHEMA speaking_independent;
-- Catalogue vẫn duyệt từng mã; chỉ bỏ danh sách cứng của tên trang cho bài tương lai.
ALTER TABLE speaking_homework.assignment_template DROP CONSTRAINT assignment_template_page_path_check,
  ADD CONSTRAINT assignment_template_page_path_check CHECK
    (page_path='index.html' OR page_path ~ '^lesson-([3-9]|[1-9][0-9]+)\.html$');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='speaking_independent_api') THEN
    CREATE ROLE speaking_independent_api NOLOGIN;
  END IF;
END $$;

CREATE TABLE speaking_independent.profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_ref UUID NOT NULL,
  profile_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('member','document')),
  class_id BIGINT, class_code TEXT, student_ref UUID, student_name TEXT NOT NULL,
  course_id TEXT, linked_profile_id UUID REFERENCES speaking_independent.profile(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind='member' AND class_id IS NOT NULL AND student_ref IS NOT NULL AND course_id IS NOT NULL)
    OR kind='document'),
  CHECK(linked_profile_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX independent_member_profile ON speaking_independent.profile(class_id,student_ref) WHERE kind='member';
CREATE TABLE speaking_independent.work_unit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES speaking_independent.profile(id),
  assignment_code TEXT NOT NULL, context_key TEXT NOT NULL,
  template JSONB NOT NULL, template_digest CHAR(64) NOT NULL,
  document_id TEXT, tab_id TEXT, document_revision TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('web','document')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted')),
  token_hash CHAR(64) NOT NULL UNIQUE, revoked_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(profile_id,assignment_code,context_key),
  CHECK ((document_id IS NULL AND tab_id IS NULL) OR (document_id IS NOT NULL AND tab_id IS NOT NULL))
);
CREATE TABLE speaking_independent.document_binding (
  document_id TEXT NOT NULL, tab_id TEXT NOT NULL, assignment_code TEXT NOT NULL,
  work_unit_id UUID NOT NULL REFERENCES speaking_independent.work_unit(id),
  verified_revision TEXT NOT NULL, template_digest CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(document_id,tab_id,assignment_code)
);
CREATE TABLE speaking_independent.source_assignment (
  course_id TEXT NOT NULL, course_work_id TEXT NOT NULL, assignment_code TEXT NOT NULL,
  class_id BIGINT NOT NULL, class_code TEXT NOT NULL, title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PUBLISHED','DRAFT','DELETED')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(course_id,course_work_id)
);
CREATE TABLE speaking_independent.source_binding (
  course_id TEXT NOT NULL, course_work_id TEXT NOT NULL, submission_id TEXT NOT NULL,
  google_user_id TEXT NOT NULL, document_id TEXT NOT NULL, student_ref UUID NOT NULL,
  assignment_code TEXT NOT NULL, cta_verified_at TIMESTAMPTZ,
  work_unit_id UUID REFERENCES speaking_independent.work_unit(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','linked','review')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(course_id,course_work_id,submission_id,document_id),
  FOREIGN KEY(course_id,course_work_id) REFERENCES speaking_independent.source_assignment(course_id,course_work_id)
);
CREATE TABLE speaking_independent.link (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_unit_id UUID NOT NULL REFERENCES speaking_independent.work_unit(id),
  kind TEXT NOT NULL CHECK(kind IN ('main','practice')),
  part TEXT NOT NULL, slot INTEGER, exercise_id UUID, exercise_title TEXT,
  revision INTEGER NOT NULL CHECK(revision>0), share_url TEXT NOT NULL, share_id TEXT NOT NULL,
  fingerprint CHAR(64), question_count INTEGER, evidence JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  check_code TEXT, checked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(work_unit_id,kind,part,revision),
  CHECK((kind='main' AND slot IS NULL AND exercise_id IS NULL)
    OR (kind='practice' AND slot>0 AND exercise_id IS NOT NULL))
);
CREATE INDEX independent_latest_links ON speaking_independent.link(work_unit_id,kind,part,revision DESC);
CREATE TABLE speaking_independent.receipt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_unit_id UUID NOT NULL UNIQUE REFERENCES speaking_independent.work_unit(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE speaking_independent.job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_unit_id UUID NOT NULL REFERENCES speaking_independent.work_unit(id),
  link_id UUID REFERENCES speaking_independent.link(id),
  kind TEXT NOT NULL CHECK(kind IN ('check_main','check_practice','analyze_practice','analyze_homework','write_doc')),
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed','review')),
  attempts INTEGER NOT NULL DEFAULT 0, owner UUID, lease_until TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error TEXT,
  result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX independent_queue ON speaking_independent.job(available_at,created_at) WHERE status IN ('pending','failed','processing');
CREATE TABLE speaking_independent.claim (
  scope_key TEXT NOT NULL, share_id TEXT NOT NULL, fingerprint CHAR(64) NOT NULL,
  link_id UUID NOT NULL UNIQUE REFERENCES speaking_independent.link(id),
  work_unit_id UUID NOT NULL REFERENCES speaking_independent.work_unit(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(scope_key,share_id), UNIQUE(scope_key,fingerprint)
);
CREATE TABLE speaking_independent.doctor_recommendation (
  profile_id UUID NOT NULL REFERENCES speaking_independent.profile(id),
  exercise_id UUID NOT NULL, recommendation_count INTEGER NOT NULL DEFAULT 0,
  practice_count INTEGER NOT NULL DEFAULT 0, waiting BOOLEAN NOT NULL DEFAULT false,
  proposed_at TIMESTAMPTZ,last_practiced_at TIMESTAMPTZ,
  PRIMARY KEY(profile_id,exercise_id)
);
CREATE TABLE speaking_independent.doctor_event (
  source_key TEXT PRIMARY KEY, profile_id UUID NOT NULL REFERENCES speaking_independent.profile(id),
  exercise_id UUID NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('recommendation','practice')),
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE speaking_independent.event (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_unit_id UUID REFERENCES speaking_independent.work_unit(id),
  kind TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE speaking_independent.classroom_alert (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),course_id TEXT NOT NULL,course_work_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,student_ref UUID NOT NULL,student_name TEXT NOT NULL,classroom_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','resolved')),
  batch_id UUID,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),sent_at TIMESTAMPTZ,
  UNIQUE(course_id,course_work_id,submission_id)
);
-- API nguồn chỉ đọc định danh để chuyển sự kiện mới; không đọc bài làm hoặc hội thoại.
CREATE VIEW speaking_independent.route_source AS
 SELECT course_id,course_work_id,assignment_code,class_code,state,observed_at FROM speaking_independent.source_assignment;
CREATE VIEW speaking_independent.route_document AS
 SELECT DISTINCT document_id FROM speaking_independent.source_binding;
CREATE VIEW speaking_independent.route_alert AS
 SELECT DISTINCT batch_id FROM speaking_independent.classroom_alert WHERE batch_id IS NOT NULL;

-- Bộ giữ quyền hội thoại dùng chung: các hàng cũ không đổi; nguồn mới có FK riêng.
ALTER TABLE speaking_homework.conversation_claim
  ALTER COLUMN assignment_id DROP NOT NULL,
  ADD COLUMN independent_unit_id UUID REFERENCES speaking_independent.work_unit(id),
  DROP CONSTRAINT conversation_claim_source_kind_check,
  ADD CONSTRAINT conversation_claim_source_kind_check
    CHECK(source_kind IN ('homework','practice','legacy','independent_homework','independent_practice')),
  ADD CONSTRAINT conversation_claim_owner_check CHECK (
    (source_kind IN ('homework','practice','legacy') AND assignment_id IS NOT NULL AND independent_unit_id IS NULL)
    OR (source_kind IN ('independent_homework','independent_practice') AND assignment_id IS NULL AND independent_unit_id IS NOT NULL)
  );

-- Hàm chỉ nhận ID link đã accepted. Nó tự đọc chủ/người/đích từ DB, không tin scope do client gửi.
-- Trong một transaction: giữ scope riêng, rồi giữ khóa khóa học thật nếu có; xung đột rollback cả hai.
CREATE FUNCTION speaking_independent.reserve_claim(p_link UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r RECORD; scope TEXT;
BEGIN
  SELECT l.*,p.course_id,p.id AS profile_id INTO STRICT r
  FROM speaking_independent.link l
  JOIN speaking_independent.work_unit u ON u.id=l.work_unit_id
  JOIN speaking_independent.profile p ON p.id=u.profile_id
  WHERE l.id=p_link AND l.status='accepted' AND l.fingerprint IS NOT NULL;
  scope:=CASE WHEN r.course_id IS NOT NULL THEN 'course:'||r.course_id ELSE 'profile:'||r.profile_id::text END;
  IF r.course_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM speaking_homework.conversation_claim
      WHERE source_id=r.id AND independent_unit_id=r.work_unit_id AND course_id=r.course_id) THEN
    INSERT INTO speaking_homework.conversation_claim
      (course_id,share_id,fingerprint,source_kind,source_id,assignment_id,independent_unit_id)
    VALUES(r.course_id,r.share_id,r.fingerprint,
      CASE WHEN r.kind='main' THEN 'independent_homework' ELSE 'independent_practice' END,
      r.id,NULL,r.work_unit_id);
    END IF;
  END IF;
  INSERT INTO speaking_independent.claim(scope_key,share_id,fingerprint,link_id,work_unit_id)
    VALUES(scope,r.share_id,r.fingerprint,r.id,r.work_unit_id)
    ON CONFLICT(link_id) DO UPDATE SET scope_key=EXCLUDED.scope_key;
END $$;
REVOKE ALL ON FUNCTION speaking_independent.reserve_claim(UUID) FROM PUBLIC;
GRANT USAGE ON SCHEMA speaking_independent TO speaking_independent_api;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA speaking_independent TO speaking_independent_api;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA speaking_independent TO speaking_independent_api;
GRANT EXECUTE ON FUNCTION speaking_independent.reserve_claim(UUID) TO speaking_independent_api;
GRANT USAGE ON SCHEMA speaking_independent TO speaking_homework_api;
GRANT SELECT ON speaking_independent.route_source,speaking_independent.route_document,speaking_independent.route_alert TO speaking_homework_api;
COMMIT;
