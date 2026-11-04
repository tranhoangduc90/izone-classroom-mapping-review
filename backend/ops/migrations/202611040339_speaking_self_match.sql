BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

-- Một quyết định lưu đúng nguồn và hai trạng thái để có thể đối soát từng ca.
CREATE TABLE speaking_independent.self_match_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id text NOT NULL,
  source_key text NOT NULL,
  student_ref uuid NOT NULL,
  previous jsonb NOT NULL,
  current jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, source_key, student_ref)
);

-- Một ca đang mở tương ứng một thông báo. Chỉ lưu dữ liệu đủ đối soát.
CREATE TABLE speaking_independent.self_match_notice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  reason text NOT NULL,
  class_code text NOT NULL,
  assignment_code text NOT NULL,
  document_id text NOT NULL,
  student_ref uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  message_id text,
  last_error text
);
CREATE INDEX self_match_notice_pending_idx ON speaking_independent.self_match_notice(available_at) WHERE sent_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON speaking_independent.self_match_notice TO speaking_independent_api;

-- p_student NULL là đọc thông tin màn chọn. Khi xác nhận, kiểm lại nguồn,
-- lớp và trạng thái định danh. Kết quả nghiệp vụ rõ ràng, lỗi SQL rollback cả lần ghi.
CREATE FUNCTION speaking_independent.self_match(
  p_document text, p_assignment text, p_class text, p_student uuid DEFAULT NULL,
  p_source_key text DEFAULT NULL, p_work uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  src record;
  target mapping.student_mapping_review%ROWTYPE;
  existing mapping.student_identity_mapping%ROWTYPE;
  roster mapping.classroom_roster_snapshot%ROWTYPE;
  work record;
  source_key text;
  eligible jsonb;
  result_id uuid;
  before_identity jsonb;
BEGIN
  BEGIN
    SELECT b.*, a.class_id, a.class_code, a.assignment_code AS registered_assignment INTO STRICT src
    FROM speaking_independent.source_binding b JOIN speaking_independent.source_assignment a USING(course_id, course_work_id)
    WHERE b.document_id = p_document AND a.state = 'PUBLISHED'
    FOR UPDATE OF b FOR SHARE OF a;
  EXCEPTION WHEN no_data_found THEN
    RETURN jsonb_build_object('state', 'not_registered');
  WHEN too_many_rows THEN
    IF EXISTS (SELECT 1 FROM speaking_independent.source_binding b
      JOIN speaking_independent.source_assignment a USING(course_id, course_work_id)
      WHERE b.document_id = p_document AND b.assignment_code = p_assignment
        AND a.assignment_code = p_assignment AND a.state = 'PUBLISHED') THEN
      RETURN jsonb_build_object('state', 'OWNER_UNRESOLVED');
    END IF;
    RETURN jsonb_build_object('state', 'not_registered');
  END;

  IF src.assignment_code <> p_assignment OR src.registered_assignment <> p_assignment THEN
    RETURN jsonb_build_object('state', 'not_registered');
  END IF;
  PERFORM 1 FROM mapping.classroom_course_mapping c
    WHERE c.erp_course_class_id = src.class_id AND c.classroom_course_id = src.course_id AND c.status = 'approved'
      AND upper(trim(c.erp_class_name_snapshot)) = upper(trim(src.class_code)) FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'CLASS_MISMATCH', 'classCode', src.class_code);
  END IF;
  IF p_class IS NOT NULL AND p_class <> src.class_code THEN
    RETURN jsonb_build_object('state', 'wrong_request_class', 'classCode', src.class_code);
  END IF;
  IF src.cta_verified_at IS NULL OR coalesce(trim(src.google_user_id), '') = '' THEN
    RETURN jsonb_build_object('state', 'OWNER_UNRESOLVED', 'classCode', src.class_code);
  END IF;
  IF src.status = 'review' THEN
    RETURN jsonb_build_object('state', 'MAPPING_CONFLICT', 'classCode', src.class_code);
  END IF;
  source_key := jsonb_build_array(src.course_id, src.course_work_id, src.submission_id, src.google_user_id)::text;
  IF p_student IS NOT NULL AND p_source_key IS DISTINCT FROM source_key THEN
    RETURN jsonb_build_object('state', 'source_changed');
  END IF;
  IF src.student_ref IS NOT NULL THEN
    SELECT id INTO result_id FROM speaking_independent.self_match_decision
      WHERE document_id = p_document AND self_match_decision.source_key = p_source_key AND student_ref = p_student;
    IF src.student_ref = p_student AND result_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM mapping.student_mapping_review m JOIN mapping.student_identity_mapping i
        ON i.erp_student_contact_id = m.erp_student_contact_id
      WHERE m.public_id = p_student AND m.erp_course_class_id = src.class_id AND m.status = 'approved'
        AND m.classroom_user_id = src.google_user_id AND i.google_user_id = src.google_user_id AND i.status = 'approved'
    ) THEN
      RETURN jsonb_build_object('state', 'confirmed', 'decisionId', result_id);
    END IF;
    RETURN jsonb_build_object('state', CASE WHEN p_student IS NULL THEN 'already_linked' ELSE 'MAPPING_CONFLICT' END,
      'classCode', src.class_code, 'sourceKey', source_key);
  END IF;

  SELECT * INTO roster FROM mapping.classroom_roster_snapshot r
    WHERE r.classroom_course_id = src.course_id AND r.classroom_user_id = src.google_user_id FOR SHARE;
  IF NOT FOUND OR roster.roster_state <> 'active' OR coalesce(trim(roster.classroom_email_snapshot), '') = '' THEN
    RETURN jsonb_build_object('state', 'OWNER_UNRESOLVED', 'classCode', src.class_code);
  END IF;

  IF p_student IS NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('student_ref', m.public_id, 'name', m.erp_student_name_snapshot)
      ORDER BY m.erp_student_name_snapshot, m.public_id), '[]'::jsonb) INTO eligible
    FROM mapping.student_mapping_review m
    WHERE m.erp_course_class_id = src.class_id AND m.status = 'pending_review'
      AND NOT EXISTS (SELECT 1 FROM mapping.student_identity_mapping i
        WHERE i.erp_student_contact_id = m.erp_student_contact_id AND i.status = 'approved'
          AND i.google_user_id <> src.google_user_id)
      AND EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot e
        WHERE e.erp_course_class_id = src.class_id AND e.erp_student_contact_id = m.erp_student_contact_id
          AND e.source_state = 'active' AND lower(trim(e.registration_status)) = 'on_going');
    RETURN jsonb_build_object('state', 'choose', 'sourceKey', source_key, 'classCode', src.class_code,
      'email', roster.classroom_email_snapshot, 'students', eligible);
  END IF;

  SELECT * INTO target FROM mapping.student_mapping_review m WHERE m.public_id = p_student FOR UPDATE;
  IF NOT FOUND OR target.erp_course_class_id <> src.class_id THEN
    RETURN jsonb_build_object('state', 'CLASS_MISMATCH', 'classCode', src.class_code);
  END IF;
  PERFORM 1 FROM mapping.erp_class_membership_snapshot e
    WHERE e.erp_course_class_id = src.class_id AND e.erp_student_contact_id = target.erp_student_contact_id
      AND e.source_state = 'active' AND lower(trim(e.registration_status)) = 'on_going' FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'CLASS_MISMATCH', 'classCode', src.class_code);
  END IF;
  IF target.status <> 'pending_review' OR
    (target.classroom_course_id IS NOT NULL AND target.classroom_course_id <> src.course_id) OR
    (target.classroom_user_id IS NOT NULL AND target.classroom_user_id <> src.google_user_id) OR EXISTS (
      SELECT 1 FROM mapping.student_mapping_review m WHERE m.status = 'approved' AND
      ((m.erp_student_contact_id <> target.erp_student_contact_id AND m.classroom_user_id = src.google_user_id)
        OR (m.erp_student_contact_id = target.erp_student_contact_id AND m.classroom_user_id <> src.google_user_id))
    ) THEN
    RETURN jsonb_build_object('state', 'MAPPING_CONFLICT', 'classCode', src.class_code);
  END IF;
  IF EXISTS (SELECT 1 FROM mapping.student_mapping_review m
    WHERE m.erp_course_class_id = src.class_id AND m.public_id <> p_student AND m.status IN ('pending_review','approved')
      AND lower(trim(m.erp_student_name_snapshot)) = lower(trim(target.erp_student_name_snapshot))
      AND EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot e
        WHERE e.erp_course_class_id = src.class_id AND e.erp_student_contact_id = m.erp_student_contact_id
          AND e.source_state = 'active' AND lower(trim(e.registration_status)) = 'on_going')) THEN
    RETURN jsonb_build_object('state', 'MAPPING_CONFLICT', 'classCode', src.class_code);
  END IF;

  SELECT u.id, u.status, p.student_ref, p.class_id, p.course_id INTO work
  FROM speaking_independent.work_unit u JOIN speaking_independent.profile p ON p.id = u.profile_id
  WHERE u.id = p_work AND u.document_id = p_document AND u.assignment_code = p_assignment AND u.revoked_at IS NULL
  FOR UPDATE OF u, p;
  IF NOT FOUND OR (work.student_ref IS NOT NULL AND work.student_ref <> p_student)
    OR (work.class_id IS NOT NULL AND work.class_id <> src.class_id)
    OR (work.course_id IS NOT NULL AND work.course_id <> src.course_id)
    OR EXISTS (SELECT 1 FROM speaking_independent.work_unit u JOIN speaking_independent.profile p ON p.id = u.profile_id
      WHERE u.id <> p_work AND u.assignment_code = p_assignment AND
        (u.document_id = p_document OR (p.class_id = src.class_id AND p.student_ref = p_student))) THEN
    RETURN jsonb_build_object('state', 'MAPPING_CONFLICT', 'classCode', src.class_code);
  END IF;

  -- Không ghi đè định danh toàn cục, kể cả khi một nguồn khác vừa chốt.
  SELECT * INTO existing FROM mapping.student_identity_mapping i
    WHERE i.erp_student_contact_id = target.erp_student_contact_id FOR UPDATE;
  before_identity := CASE WHEN FOUND THEN to_jsonb(existing) ELSE 'null'::jsonb END;
  INSERT INTO mapping.student_identity_mapping (erp_student_contact_id, google_user_id, google_email_snapshot,
    erp_name_snapshot, google_name_snapshot, status, match_method, approved_by, approved_at, last_seen_at)
  VALUES (target.erp_student_contact_id, src.google_user_id, roster.classroom_email_snapshot,
    target.erp_student_name_snapshot, roster.classroom_name_snapshot, 'approved', 'manual', 'speaking-self-confirm@izone.invalid', now(), now())
  ON CONFLICT DO NOTHING;
  SELECT * INTO existing FROM mapping.student_identity_mapping i
    WHERE i.erp_student_contact_id = target.erp_student_contact_id AND i.google_user_id = src.google_user_id
      AND i.status = 'approved' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'MAPPING_CONFLICT', 'classCode', src.class_code);
  END IF;

  UPDATE mapping.student_mapping_review SET classroom_course_id = src.course_id, classroom_user_id = src.google_user_id,
    classroom_name_snapshot = roster.classroom_name_snapshot, classroom_email_snapshot = roster.classroom_email_snapshot,
    status = 'approved', match_method = 'manual', reviewer_email = 'speaking-self-confirm@izone.invalid',
    reviewer_note = 'Speaking CTA: người học xác nhận một lần', decided_at = now(), updated_at = now()
  WHERE id = target.id;
  INSERT INTO speaking_independent.self_match_decision(document_id, source_key, student_ref, previous, current)
  SELECT p_document, source_key, p_student, jsonb_build_object('review', to_jsonb(target), 'identity', before_identity),
    jsonb_build_object('review', to_jsonb(m), 'identity', to_jsonb(existing))
  FROM mapping.student_mapping_review m WHERE m.id = target.id RETURNING id INTO result_id;
  INSERT INTO mapping.mapping_decision_event(review_id, decision, selected_google_user_id, reviewer_email, note)
  VALUES (target.id, 'approve', src.google_user_id, 'speaking-self-confirm@izone.invalid', 'Speaking self-confirm ' || result_id);
  UPDATE speaking_independent.source_binding SET student_ref = p_student
    WHERE course_id = src.course_id AND course_work_id = src.course_work_id AND submission_id = src.submission_id
      AND document_id = p_document;
  RETURN jsonb_build_object('state', 'confirmed', 'decisionId', result_id);
END $$;

REVOKE ALL ON FUNCTION speaking_independent.self_match(text,text,text,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION speaking_independent.self_match(text,text,text,uuid,text,uuid) TO speaking_independent_api;

COMMIT;
