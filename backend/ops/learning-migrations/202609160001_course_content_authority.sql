-- Dữ liệu nhận vào: quyền chuyên môn theo khóa do chủ hệ thống xác nhận.
-- Việc chính: cho phép lead của đúng khóa tự duyệt form có điểm mà không gỡ cổng duyệt ở khóa khác.
-- Kết quả: mọi ngoại lệ có phạm vi, trạng thái và căn cứ cấp quyền để truy vết.
-- Khi lỗi: form có điểm vẫn bị từ chối phát hành; không tự hạ tiêu chuẩn duyệt.

CREATE TABLE IF NOT EXISTS learning.course_content_authority (
  reviewer_email TEXT NOT NULL,
  course_code TEXT NOT NULL CHECK (course_code ~ '^[a-z0-9][a-z0-9_.-]{1,79}$'),
  authority_role TEXT NOT NULL DEFAULT 'course_lead' CHECK (authority_role = 'course_lead'),
  can_self_approve_scored_forms BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  grant_reference TEXT NOT NULL CHECK (length(trim(grant_reference)) BETWEEN 8 AND 500),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reviewer_email, course_code),
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION learning.enforce_scored_form_second_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_scored_item BOOLEAN;
  has_course_lead_authority BOOLEAN := false;
  definition_course_code TEXT;
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

  IF has_scored_item AND NEW.approved_by_email = NEW.created_by_email THEN
    definition_course_code := lower(trim(COALESCE(NEW.public_definition ->> 'courseCode', '')));
    SELECT EXISTS (
      SELECT 1
      FROM learning.course_content_authority AS authority
      WHERE lower(trim(authority.reviewer_email)) = lower(trim(NEW.created_by_email))
        AND authority.course_code = definition_course_code
        AND authority.can_self_approve_scored_forms = true
        AND authority.status = 'active'
    ) INTO has_course_lead_authority;
  END IF;

  IF has_scored_item
     AND (NEW.approved_by_email IS NULL
       OR (NEW.approved_by_email = NEW.created_by_email AND NOT has_course_lead_authority)) THEN
    RAISE EXCEPTION 'FORM_SECOND_APPROVAL_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'learning_api') THEN
    GRANT SELECT ON learning.course_content_authority TO learning_api;
  END IF;
END
$$;
