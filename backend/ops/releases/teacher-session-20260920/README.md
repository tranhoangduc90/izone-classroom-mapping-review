# Phiên đăng nhập dài hạn cho dashboard giảng viên

Bản phát hành này giữ nguyên image production ngày 18/09/2026 và chỉ thêm phiên giảng viên dùng cookie `HttpOnly` cho profile K67 tại `/mapping-api/`.

- Google credential chỉ dùng một lần để mở phiên.
- Database chỉ lưu SHA-256 của token phiên; đăng xuất thu hồi phiên phía máy chủ.
- Phiên tự gia hạn khi dùng, hết hạn sau 90 ngày không hoạt động và tối đa 365 ngày.
- Cookie có `Secure`, `SameSite=None`, `Partitioned` và path `/mapping-api` để dùng an toàn từ GitHub Pages mà không gửi sang API K56/demo.
- Request ghi bằng cookie bắt buộc origin hợp lệ và `x-izone-csrf: 1`.
- Bearer Google cũ được giữ tạm ở backend để có thể phát hành API trước giao diện.

Docker build kiểm hash của `app.js`, `auth.js` và `config.js` trước khi thay đổi. Nếu image nền không đúng, build dừng. Rollback ứng dụng dùng lại image `izone-term-test-backend:20260918.1-listening-retake-unlimited`; bảng phiên được giữ lại để điều tra, không xóa dữ liệu.

## Readback production — 20/09/2026

- Database backup ID `teacher-session-20260920T030932Z`; hai migration phiên và quyền schema đã có trong ledger.
- Image `izone-term-test-backend:20260920.1-teacher-session`, image ID bắt đầu bằng `ca1d8920`, health/version trả `1.9.0-teacher-session`, profile `k67`.
- Container healthy, restart count 0, giữ 0,5 CPU và 256 MB RAM. K56/demo không được dựng lại.
- CORS công khai đúng origin GitHub Pages, có `Access-Control-Allow-Credentials`, hỗ trợ `DELETE` và `x-izone-csrf`.
- Ca HTTPS bằng tài khoản QA giả đã khôi phục phiên, nhận cookie đủ `HttpOnly`, `Secure`, `SameSite=None`, `Partitioned`, đăng xuất HTTP 200 và xóa sạch fixture.
- Lần dựng đầu tiên dùng giá trị `SameSite` viết hoa nên config dừng fail-closed. Container được đưa về image nền healthy, cấu hình đổi thành `none`, kiểm lại Compose rồi mới phát hành thành công.
