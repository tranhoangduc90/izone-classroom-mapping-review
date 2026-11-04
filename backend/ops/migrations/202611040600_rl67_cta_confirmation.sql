-- Đầu vào: CTA và bản sao Classroom do runtime native đã kiểm bằng Google API.
-- Kết quả: chọn đúng hồ sơ đang học, ghi một quyết định cùng giao dịch.
-- Mọi lỗi nghiệp vụ trả trạng thái rõ ràng, lỗi SQL quay lui toàn bộ lần ghi.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));
DO $role$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rl67_cta_confirmation_api') THEN
    CREATE ROLE rl67_cta_confirmation_api NOLOGIN;
  END IF;
END $role$;

CREATE SCHEMA rl67_cta_confirmation;
REVOKE ALL ON SCHEMA rl67_cta_confirmation FROM PUBLIC;
GRANT USAGE ON SCHEMA rl67_cta_confirmation TO rl67_cta_confirmation_api;

CREATE TABLE rl67_cta_confirmation.entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id text NOT NULL,
  course_id text NOT NULL,
  coursework_id text NOT NULL,
  submission_id text NOT NULL,
  product text NOT NULL CHECK (product IN ('reading-homework','listening-homework','reading-practice','listening-practice')),
  assignment_code text NOT NULL CHECK (assignment_code ~ '^67-((reading|listening)-|practice-(reading|listening)_)[A-Za-z0-9_-]+$' AND length(assignment_code)<=120),
  fallback_path text NOT NULL CHECK (length(fallback_path) BETWEEN 1 AND 500),
  class_id bigint NOT NULL,
  class_code text NOT NULL,
  google_user_id text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id,product,assignment_code)
);
CREATE TABLE rl67_cta_confirmation.decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL UNIQUE REFERENCES rl67_cta_confirmation.entry(id),
  student_ref uuid NOT NULL,
  previous jsonb NOT NULL,
  current jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rl67_confirmed_owner_lookup ON rl67_cta_confirmation.entry
  (class_id,course_id,google_user_id,product) WHERE verified_at IS NOT NULL;
CREATE TABLE rl67_cta_confirmation.notice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES rl67_cta_confirmation.entry(id),
  product text NOT NULL,
  assignment_code text NOT NULL,
  class_code text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('CLASS_MISMATCH','OWNER_UNRESOLVED','MAPPING_CONFLICT','BINDING_UNAVAILABLE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  lease_id uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  message_id text,
  last_error text,
  UNIQUE (entry_id,reason)
);
CREATE INDEX rl67_confirmation_notices_ready ON rl67_cta_confirmation.notice(available_at,id)
  WHERE sent_at IS NULL;
GRANT SELECT, UPDATE ON rl67_cta_confirmation.notice TO rl67_cta_confirmation_api;

CREATE FUNCTION rl67_cta_confirmation.prepare(
  p_product text, p_assignment text, p_path text, p_doc text, p_course text,
  p_coursework text, p_submission text, p_google text, p_class text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE erp_class bigint; entry_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rl67-source:'||p_doc,0));
  IF EXISTS (SELECT 1 FROM rl67_cta_confirmation.entry e WHERE e.document_id=p_doc AND
    (e.course_id,e.coursework_id,e.submission_id,e.google_user_id,e.class_code)
      IS DISTINCT FROM (p_course,p_coursework,p_submission,p_google,p_class))
    THEN RETURN NULL; END IF;
  SELECT c.erp_course_class_id INTO STRICT erp_class
  FROM mapping.classroom_course_mapping c
  WHERE c.classroom_course_id=p_course AND c.status='approved' AND upper(trim(c.erp_class_name_snapshot))=p_class
  FOR SHARE OF c;
  IF EXISTS (SELECT 1 FROM mapping.student_mapping_review m
    WHERE m.erp_course_class_id=erp_class AND m.classroom_course_id=p_course
      AND m.classroom_user_id=p_google AND m.status='approved')
    THEN RETURN NULL; END IF;
  INSERT INTO rl67_cta_confirmation.entry(document_id,course_id,coursework_id,submission_id,product,assignment_code,
    fallback_path,class_id,class_code,google_user_id)
    VALUES(p_doc,p_course,p_coursework,p_submission,p_product,p_assignment,p_path,erp_class,p_class,p_google)
  ON CONFLICT (document_id,product,assignment_code) DO UPDATE SET fallback_path=EXCLUDED.fallback_path
  WHERE entry.class_id=EXCLUDED.class_id AND entry.class_code=EXCLUDED.class_code
    AND entry.google_user_id=EXCLUDED.google_user_id AND entry.fallback_path=EXCLUDED.fallback_path
  RETURNING id INTO entry_id;
  RETURN entry_id;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RETURN NULL;
END $$;

CREATE FUNCTION rl67_cta_confirmation.activate(p_id uuid,p_product text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH changed AS (
    UPDATE rl67_cta_confirmation.entry SET verified_at=coalesce(verified_at,now())
    WHERE id=p_id AND product=p_product RETURNING id
  ) SELECT EXISTS (SELECT 1 FROM changed)
$$;

CREATE FUNCTION rl67_cta_confirmation.record_notice(p_id uuid,p_reason text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  INSERT INTO rl67_cta_confirmation.notice(entry_id,product,assignment_code,class_code,reason)
  SELECT id,product,assignment_code,class_code,p_reason
  FROM rl67_cta_confirmation.entry WHERE id=p_id AND verified_at IS NOT NULL
  ON CONFLICT(entry_id,reason) DO NOTHING
$$;

CREATE FUNCTION rl67_cta_confirmation.resolve(p_id uuid,p_student uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e rl67_cta_confirmation.entry%ROWTYPE;
        roster mapping.classroom_roster_snapshot%ROWTYPE;
        target mapping.student_mapping_review%ROWTYPE;
        identity mapping.student_identity_mapping%ROWTYPE;
        old_identity jsonb;
        result_id uuid;
        eligible jsonb;
        context jsonb;
BEGIN
  SELECT * INTO e FROM rl67_cta_confirmation.entry WHERE id=p_id AND verified_at IS NOT NULL FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','not_found'); END IF;
  PERFORM 1 FROM mapping.classroom_course_mapping c
  WHERE c.erp_course_class_id=e.class_id AND c.classroom_course_id=e.course_id AND c.status='approved'
    AND upper(trim(c.erp_class_name_snapshot))=e.class_code FOR SHARE OF c;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','CLASS_MISMATCH'); END IF;
  SELECT * INTO roster FROM mapping.classroom_roster_snapshot
    WHERE classroom_course_id=e.course_id AND classroom_user_id=e.google_user_id FOR SHARE;
  IF NOT FOUND OR roster.roster_state<>'active' OR nullif(trim(roster.classroom_email_snapshot),'') IS NULL
    THEN RETURN jsonb_build_object('state','OWNER_UNRESOLVED'); END IF;
  context := jsonb_build_object('product',e.product,'assignmentCode',e.assignment_code,'fallbackPath',e.fallback_path,
    'classCode',e.class_code,'classId',e.class_id,'courseId',e.course_id,'courseWorkId',e.coursework_id,
    'submissionId',e.submission_id,'documentId',e.document_id,'googleUserId',e.google_user_id);

  -- Đồng bộ lại sau một lần xác nhận khác sản phẩm hoặc sau khi người quản trị đã duyệt.
  IF p_student IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('rl67-confirm:'||e.google_user_id,0));
  END IF;
  BEGIN
    SELECT m.* INTO STRICT target FROM mapping.student_mapping_review m
    WHERE m.erp_course_class_id=e.class_id AND m.classroom_course_id=e.course_id
      AND m.classroom_user_id=e.google_user_id AND m.status='approved'
      AND EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot r
        WHERE r.erp_course_class_id=e.class_id AND r.erp_student_contact_id=m.erp_student_contact_id
          AND r.source_state='active' AND lower(trim(r.registration_status))='on_going')
    FOR SHARE OF m;
    IF p_student IS NOT NULL AND p_student<>target.public_id THEN
      RETURN jsonb_build_object('state','MAPPING_CONFLICT');
    END IF;
    SELECT id INTO result_id FROM rl67_cta_confirmation.decision WHERE entry_id=e.id AND student_ref=target.public_id;
    RETURN context || jsonb_build_object('state','linked','studentRef',target.public_id,'decisionId',result_id);
  EXCEPTION WHEN no_data_found THEN NULL;
    WHEN too_many_rows THEN RETURN jsonb_build_object('state','MAPPING_CONFLICT');
  END;

  IF p_student IS NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('studentRef',m.public_id,'name',m.erp_student_name_snapshot)
      ORDER BY m.erp_student_name_snapshot,m.public_id),'[]') INTO eligible
    FROM mapping.student_mapping_review m
    WHERE m.erp_course_class_id=e.class_id AND m.status='pending_review'
      AND (m.classroom_course_id IS NULL OR m.classroom_course_id=e.course_id)
      AND (m.classroom_user_id IS NULL OR m.classroom_user_id=e.google_user_id)
      AND NOT EXISTS (SELECT 1 FROM mapping.student_identity_mapping i
        WHERE i.erp_student_contact_id=m.erp_student_contact_id AND i.status='approved' AND i.google_user_id<>e.google_user_id)
      AND EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot r
        WHERE r.erp_course_class_id=e.class_id AND r.erp_student_contact_id=m.erp_student_contact_id
          AND r.source_state='active' AND lower(trim(r.registration_status))='on_going');
    RETURN context || jsonb_build_object('state','choose','account',trim(roster.classroom_email_snapshot),'students',eligible);
  END IF;
  SELECT * INTO target FROM mapping.student_mapping_review WHERE public_id=p_student FOR UPDATE;
  IF NOT FOUND OR target.erp_course_class_id<>e.class_id
    THEN RETURN jsonb_build_object('state','CLASS_MISMATCH'); END IF;
  PERFORM 1 FROM mapping.erp_class_membership_snapshot r
    WHERE r.erp_course_class_id=e.class_id AND r.erp_student_contact_id=target.erp_student_contact_id
      AND r.source_state='active' AND lower(trim(r.registration_status))='on_going' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','CLASS_MISMATCH'); END IF;
  IF target.status<>'pending_review'
    OR (target.classroom_course_id IS NOT NULL AND target.classroom_course_id<>e.course_id)
    OR (target.classroom_user_id IS NOT NULL AND target.classroom_user_id<>e.google_user_id)
    OR EXISTS (SELECT 1 FROM mapping.student_mapping_review m WHERE m.status='approved' AND (
      (m.erp_student_contact_id<>target.erp_student_contact_id AND m.classroom_user_id=e.google_user_id) OR
      (m.erp_student_contact_id=target.erp_student_contact_id AND m.classroom_user_id<>e.google_user_id)))
    OR EXISTS (SELECT 1 FROM mapping.student_mapping_review m
      JOIN mapping.erp_class_membership_snapshot r USING (erp_course_class_id,erp_student_contact_id)
      WHERE m.erp_course_class_id=e.class_id AND m.public_id<>p_student AND m.status IN ('pending_review','approved')
        AND lower(trim(m.erp_student_name_snapshot))=lower(trim(target.erp_student_name_snapshot))
        AND r.source_state='active' AND lower(trim(r.registration_status))='on_going')
    THEN RETURN jsonb_build_object('state','MAPPING_CONFLICT'); END IF;
  SELECT * INTO identity FROM mapping.student_identity_mapping WHERE erp_student_contact_id=target.erp_student_contact_id FOR UPDATE;
  old_identity:=CASE WHEN FOUND THEN to_jsonb(identity) ELSE 'null'::jsonb END;
  INSERT INTO mapping.student_identity_mapping(erp_student_contact_id,google_user_id,google_email_snapshot,
    erp_name_snapshot,google_name_snapshot,status,match_method,approved_by,approved_at,last_seen_at)
  VALUES(target.erp_student_contact_id,e.google_user_id,roster.classroom_email_snapshot,target.erp_student_name_snapshot,
    roster.classroom_name_snapshot,'approved','manual','rl67-self-confirm@izone.invalid',now(),now())
  ON CONFLICT DO NOTHING;
  SELECT * INTO identity FROM mapping.student_identity_mapping WHERE erp_student_contact_id=target.erp_student_contact_id
    AND google_user_id=e.google_user_id AND status='approved' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','MAPPING_CONFLICT'); END IF;
  UPDATE mapping.student_mapping_review SET classroom_course_id=e.course_id,classroom_user_id=e.google_user_id,
    classroom_name_snapshot=roster.classroom_name_snapshot,classroom_email_snapshot=roster.classroom_email_snapshot,
    status='approved',match_method='manual',reviewer_email='rl67-self-confirm@izone.invalid',
    reviewer_note='Học viên xác nhận một lần qua CTA Classroom',decided_at=now(),updated_at=now()
  WHERE id=target.id;
  INSERT INTO rl67_cta_confirmation.decision(entry_id,student_ref,previous,current)
  SELECT e.id,p_student,jsonb_build_object('review',to_jsonb(target),'identity',old_identity),
    jsonb_build_object('review',to_jsonb(m),'identity',to_jsonb(identity))
  FROM mapping.student_mapping_review m WHERE m.id=target.id RETURNING id INTO result_id;
  INSERT INTO mapping.mapping_decision_event(review_id,decision,selected_google_user_id,reviewer_email,note)
  VALUES(target.id,'approve',e.google_user_id,'rl67-self-confirm@izone.invalid','Reading/Listening CTA '||result_id);
  RETURN context || jsonb_build_object('state','linked','studentRef',p_student,'decisionId',result_id);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rl67_cta_confirmation FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rl67_cta_confirmation TO rl67_cta_confirmation_api;

-- Các nguồn owner V1 giữ quyền cũ. Ngoài danh sách lớp lịch sử, chỉ thêm đúng
-- chủ đã duyệt của CTA được xác minh cho sản phẩm dùng nguồn đó.
CREATE OR REPLACE VIEW reading_owner_api_v1.owner AS
SELECT m.erp_course_class_id::text AS class_id,m.public_id AS student_ref,
  c.classroom_course_id AS course_id,m.classroom_user_id AS google_user_id
FROM mapping.student_mapping_review m
JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id=m.erp_course_class_id AND c.status='approved'
WHERE m.status='approved' AND m.classroom_user_id IS NOT NULL AND m.classroom_course_id=c.classroom_course_id
  AND (m.erp_course_class_id=ANY(ARRAY[-8062028,1124,1131,1135,1157,1166,1187,1199,1226,1250,1293,1345]::bigint[])
    OR EXISTS (SELECT 1 FROM rl67_cta_confirmation.entry a
      WHERE a.class_id=m.erp_course_class_id AND a.course_id=m.classroom_course_id
        AND a.google_user_id=m.classroom_user_id AND a.verified_at IS NOT NULL
        AND a.product IN ('reading-homework','reading-practice','listening-homework')))
  AND EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot e
    WHERE e.erp_course_class_id=m.erp_course_class_id AND e.erp_student_contact_id=m.erp_student_contact_id
      AND e.source_state='active' AND lower(trim(coalesce(e.registration_status,''))) NOT IN ('dropped','on_hold'));

CREATE OR REPLACE VIEW listening_owner_api_v1.owner AS
SELECT m.erp_course_class_id::text AS class_id,m.public_id AS student_ref,
  c.classroom_course_id AS course_id,m.classroom_user_id AS google_user_id
FROM mapping.student_mapping_review m
JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id=m.erp_course_class_id AND c.status='approved'
WHERE m.status='approved' AND m.classroom_user_id IS NOT NULL AND m.classroom_course_id=c.classroom_course_id
  AND (m.erp_course_class_id=ANY(ARRAY[-8062028,1124,1131,1135,1157,1166,1187,1199,1226,1250,1293]::bigint[])
    OR EXISTS (SELECT 1 FROM rl67_cta_confirmation.entry a
      WHERE a.class_id=m.erp_course_class_id AND a.course_id=m.classroom_course_id
        AND a.google_user_id=m.classroom_user_id AND a.verified_at IS NOT NULL
        AND a.product IN ('listening-homework','listening-practice')))
  AND EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot e
    WHERE e.erp_course_class_id=m.erp_course_class_id AND e.erp_student_contact_id=m.erp_student_contact_id
      AND e.source_state='active' AND lower(trim(coalesce(e.registration_status,''))) NOT IN ('dropped','on_hold'));
COMMIT;
