-- Dữ liệu nhận vào: đúng bốn email của đợt cấp quyền 28/09/2026.
-- Việc chính: thu hồi riêng quyền Progress Log; giữ tài khoản và quyền lớp vốn có.
-- Kết quả: bốn quyền chuyển sang revoked và có thời điểm thu hồi.
-- Khi lỗi: transaction rollback, không để trạng thái thu hồi dở dang.
BEGIN;

UPDATE learning.progress_log_admin
SET status = 'revoked', revoked_at = now(), updated_at = now()
WHERE reviewer_email IN ('danhhien94@gmail.com', 'gia081004@gmail.com', 'chinhleenglish@gmail.com', 'tuanhung.bui.ec@gmail.com')
  AND grant_reference = 'Đức xác nhận ngày 28/09/2026: quản trị Progress Log trên mọi lớp';

SELECT reviewer_email, status, revoked_at IS NOT NULL AS has_revoked_at
FROM learning.progress_log_admin
WHERE reviewer_email IN ('danhhien94@gmail.com', 'gia081004@gmail.com', 'chinhleenglish@gmail.com', 'tuanhung.bui.ec@gmail.com')
ORDER BY reviewer_email;

COMMIT;
