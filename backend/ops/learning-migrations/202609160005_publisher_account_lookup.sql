-- Người phát hành chỉ cần đối chiếu email và trạng thái của tài khoản duyệt.
-- Không cấp quyền đọc các cột hồ sơ khác cho dịch vụ Progress Log.
GRANT SELECT (email, status) ON mapping.reviewer_account TO learning_api;
