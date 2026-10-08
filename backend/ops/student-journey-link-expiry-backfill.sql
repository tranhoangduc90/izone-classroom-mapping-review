-- Chỉ chạy sau khi mọi instance API và bản quay lui đọc được expires_at=NULL.
-- Nhận các link hiện có; bỏ hạn chỉ cho link active còn hiệu lực, giữ hash/trạng thái.
-- Khi khóa/lỗi/readback sai: rollback; không hồi sinh link expired hoặc revoked.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
LOCK TABLE learning.student_progress_access IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE journey_expiry_before ON COMMIT DROP AS
SELECT id,token_hash,status,expires_at,
  (status='active' AND expires_at>now()) AS eligible
FROM learning.student_progress_access;
UPDATE learning.student_progress_access
SET expires_at=NULL,updated_at=now()
WHERE status='active' AND expires_at>now();
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM journey_expiry_before b
    LEFT JOIN learning.student_progress_access a ON a.id=b.id
    WHERE a.id IS NULL OR a.token_hash<>b.token_hash OR a.status<>b.status
      OR (b.eligible AND a.expires_at IS NOT NULL)
      OR (NOT coalesce(b.eligible,false) AND a.expires_at IS DISTINCT FROM b.expires_at)) THEN
    RAISE EXCEPTION 'Đọc lại hạn link không khớp; giữ nguyên dữ liệu.';
  END IF;
END $$;
SELECT json_build_object('converted',count(*) FILTER(WHERE eligible),
  'untouched',count(*) FILTER(WHERE NOT coalesce(eligible,false))) AS expiry_readback
FROM journey_expiry_before;
COMMIT;
