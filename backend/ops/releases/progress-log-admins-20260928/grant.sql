-- Dữ liệu nhận vào: bốn email do Đức xác nhận và migration quyền Progress Log đã áp dụng.
-- Việc chính: tạo tài khoản giáo viên còn thiếu, kiểm không có quyền rộng, rồi cấp quyền Progress Log.
-- Kết quả: bốn tài khoản hoạt động, quản trị mọi lớp chỉ trong Progress Log.
-- Khi lỗi: transaction rollback toàn bộ; không sửa quyền hệ thống khác.
BEGIN;

INSERT INTO mapping.reviewer_account (email, role, status, can_access_all_classes)
VALUES
  ('danhhien94@gmail.com', 'teacher', 'active', false),
  ('gia081004@gmail.com', 'teacher', 'active', false),
  ('chinhleenglish@gmail.com', 'teacher', 'active', false),
  ('tuanhung.bui.ec@gmail.com', 'teacher', 'active', false)
ON CONFLICT (email) DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM mapping.reviewer_account
      WHERE email IN ('danhhien94@gmail.com', 'gia081004@gmail.com', 'chinhleenglish@gmail.com', 'tuanhung.bui.ec@gmail.com')
        AND status = 'active' AND role = 'teacher'
        AND can_access_all_classes = false) <> 4 THEN
    RAISE EXCEPTION 'PROGRESS_LOG_ADMIN_ACCOUNT_SCOPE_MISMATCH';
  END IF;
END
$$;

INSERT INTO learning.progress_log_admin (reviewer_email, status, grant_reference)
SELECT email, 'active', 'Đức xác nhận ngày 28/09/2026: quản trị Progress Log trên mọi lớp'
FROM mapping.reviewer_account
WHERE email IN ('danhhien94@gmail.com', 'gia081004@gmail.com', 'chinhleenglish@gmail.com', 'tuanhung.bui.ec@gmail.com')
ON CONFLICT (reviewer_email) DO UPDATE SET
  status = 'active',
  grant_reference = EXCLUDED.grant_reference,
  revoked_at = NULL,
  updated_at = now();

SELECT account.email, account.status AS account_status, account.role,
       account.can_access_all_classes, admin.status AS progress_log_status
FROM mapping.reviewer_account AS account
JOIN learning.progress_log_admin AS admin ON admin.reviewer_email = account.email
WHERE account.email IN ('danhhien94@gmail.com', 'gia081004@gmail.com', 'chinhleenglish@gmail.com', 'tuanhung.bui.ec@gmail.com')
ORDER BY account.email;

COMMIT;
