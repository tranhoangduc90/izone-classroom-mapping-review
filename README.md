# Màn hình duyệt ghép học viên

Đây là giao diện tĩnh dành cho giảng viên xác nhận đề xuất ghép học viên trong ERP với tài khoản Google Classroom. Repo không chứa dữ liệu học viên thật. Backend độc lập chạy trong container riêng trên VPS; n8n chỉ quét và đồng bộ dữ liệu nền.

## Cách sử dụng

Mở trang GitHub Pages và đăng nhập bằng tài khoản Google đã được quản trị viên cấp quyền. Giảng viên không cần dùng cùng tên miền. Google ID token chỉ nằm trong bộ nhớ tab và không được lưu vào repo hoặc PostgreSQL.

## Kiến trúc được đề xuất

- Metabase: lớp đọc ERP, thông qua Apps Script/n8n; không để credential trong trình duyệt.
- Google Apps Script của tài khoản chủ lớp: đọc danh sách course và roster Classroom bằng quyền của giáo viên.
- PostgreSQL riêng cho tích hợp: lưu mapping đã duyệt, hàng chờ AI, lịch sử quyết định và snapshot roster.
- GitHub Pages: chỉ phục vụ HTML/CSS/JavaScript. API độc lập xác thực Google, kiểm tra quyền theo lớp và giới hạn CORS về origin GitHub Pages.
- n8n: chỉ chạy lịch quét ERP/Classroom/Lark; việc giảng viên tải hay duyệt không chiếm execution slot n8n.

Mapping đã duyệt là nguồn dùng chung cho các workflow về bài tập, điểm danh và hành chính. Email ERP trùng chính xác email Classroom được tự duyệt nếu không xung đột; các trường hợp ghép theo tên vẫn cần giảng viên xác nhận. Thuật toán chạy cục bộ và không gửi dữ liệu học viên sang mô hình AI bên ngoài.

Trong view `Đã duyệt`, giảng viên có thể sửa tài khoản Classroom hoặc mở lại phiếu để duyệt lại. Workflow hằng ngày phát hiện học viên mới vào lớp, rời lớp, chuyển lớp và đổi tên/email Google. Nếu Google ID không đổi, tên/email mới được cập nhật vào mapping hiện có mà không cần duyệt lại.

## Trạng thái triển khai

- PostgreSQL `mapping_db` lưu mapping, snapshot thành viên lớp và lịch sử thay đổi từ ERP/Classroom/Lark.
- Workflow đồng bộ đọc toàn bộ lớp trong view Lark đã chọn, quét mỗi ngày lúc 04:30 và vẫn có nút chạy thủ công.
- API độc lập hoạt động tại `/mapping-api/`, dùng Google Sign-In và phân quyền theo lớp trong PostgreSQL.
- API n8n cũ vẫn được giữ tạm thời làm phương án quay lại; giao diện không còn gọi endpoint này.
- `config.js` đặt `DEMO_MODE: false` để giao diện tải dữ liệu thật sau khi xác thực.

## Vận hành API độc lập

`config.js` dùng `API_BASE_URL` là `https://ducizone.ddns.net/mapping-api` và `AUTH_MODE` là `google`. Chỉ tắt API n8n cũ sau khi giao diện mới đã vận hành ổn định qua giai đoạn dự phòng.

Không đặt mật khẩu Metabase, mật khẩu PostgreSQL, API key, token hoặc dữ liệu học viên vào repo.

Hợp đồng request/response nằm ở `docs/data-contract.md`; bản phác thảo PostgreSQL nằm ở `docs/schema.sql`.

## GitHub Pages

Trang được triển khai từ nhánh `main`, thư mục `/ (root)`. Repo chỉ chứa mã nguồn giao diện và tài liệu kỹ thuật; không đưa dữ liệu học viên hoặc credential vào lịch sử Git.
