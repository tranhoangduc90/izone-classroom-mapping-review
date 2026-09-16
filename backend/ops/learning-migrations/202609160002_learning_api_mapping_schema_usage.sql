-- Dữ liệu nhận vào: role learning_api đã có SELECT trên các bảng mapping cần thiết.
-- Việc chính: cho role đi qua schema mapping để các quyền SELECT hiện có thực sự dùng được.
-- Kết quả: dashboard giảng viên đọc danh sách lớp; không mở thêm bảng hay quyền ghi nào.
-- Khi lỗi: migration rollback và API tiếp tục fail-closed như trước.

GRANT USAGE ON SCHEMA mapping TO learning_api;
