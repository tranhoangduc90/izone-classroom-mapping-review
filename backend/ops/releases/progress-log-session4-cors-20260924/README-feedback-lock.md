# Sửa quyền khóa khi gửi nhận xét Speaking

Sau khi cho phép PUT qua CORS, yêu cầu tới endpoint thật báo lỗi `500`. Gọi cùng câu SQL với vai trò `learning_api` xác nhận SQLSTATE `42501`: vai trò này không có quyền `UPDATE` bảng roster nên không thể dùng `FOR UPDATE OF roster`.

Đổi khóa giao dịch sang `form_assignment`, nơi API đã được cấp quyền `UPDATE(status, updated_at)` trong migration Buổi 4. Các lần gửi cho cùng phiếu sẽ chờ nhau trong thời gian ngắn; vẫn giữ kiểm lớp, học viên, revision và operation ID. Không cấp thêm quyền sửa dữ liệu học viên.

Test PostgreSQL trong RAM với đúng quyền tối thiểu thất bại trên mã cũ và đạt sau sửa. Dựng image bằng `Dockerfile.feedback-lock`, chuyển bằng `deploy-feedback-lock.sh`, đọc lại health rồi gửi nhận xét qua màn giảng viên. Sau khi kiểm trang học viên, xóa hồ sơ thử và đọc lại toàn bộ số lượng dữ liệu.
