# Màn hình duyệt ghép học viên

Đây là giao diện tĩnh dành cho giảng viên xác nhận đề xuất ghép học viên trong ERP với tài khoản Google Classroom. Repo không chứa dữ liệu học viên thật. Backend độc lập chạy trong container riêng trên VPS; n8n chỉ quét và đồng bộ dữ liệu nền.

## Cách sử dụng

Mở trang GitHub Pages và đăng nhập bằng tài khoản Google đã được quản trị viên cấp quyền. Giảng viên không cần dùng cùng tên miền. Google ID token chỉ dùng một lần để mở phiên; sau đó trình duyệt dùng cookie `HttpOnly` do API cấp. PostgreSQL chỉ lưu mã băm của phiên, không lưu Google ID token.

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
- Quyền giảng viên được lưu trước theo mã lớp; khi một lớp mới có mapping ERP–Classroom, lần quét kế tiếp tự kích hoạt quyền xem lớp đó.
- API n8n cũ vẫn được giữ tạm thời làm phương án quay lại; giao diện không còn gọi endpoint này.
- `config.js` đặt `DEMO_MODE: false` để giao diện tải dữ liệu thật sau khi xác thực.

## Vận hành API độc lập

`config.js` dùng `API_BASE_URL` là `https://ducizone.ddns.net/mapping-api` và `AUTH_MODE` là `google`. Chỉ tắt API n8n cũ sau khi giao diện mới đã vận hành ổn định qua giai đoạn dự phòng.

Không đặt mật khẩu Metabase, mật khẩu PostgreSQL, API key, token hoặc dữ liệu học viên vào repo.

**Term Test/Mini Test K67 từ 06/10/2026:** source và bộ dựng riêng ở
[products/term-mini-k67](products/term-mini-k67/README.md); đọc
[trạng thái đã kiểm](products/term-mini-k67/RELEASE_STATUS.md) và
[hướng dẫn chuyển/quay lại](products/term-mini-k67/CUTOVER_PLAN.md) trước khi sửa.
K67 dùng runtime `term-mini-k67-api`, DB `term_mini_k67`, Redis và bộ workflow
riêng; API mới ở `https://ducizone.ddns.net:18869/term-mini-k67-api`. Đường
Term/Mini cũ được giữ để chuyển tới K67; 13 bảng nguồn cũ giữ chỉ đọc. K56
tiếp tục dùng runtime/tuyến hiện có. Không dựng lại backend chung để phát
hành K67 hoặc chép dump cũ đè lên kho K67 đã có bài mới.

Danh sách lớp K67 chỉ trả tên học viên cùng UUID ngẫu nhiên; bài Listening
và Reading lưu trong schema `assessment` của kho K67 riêng. Đáp án được seed
riêng, không nằm trong repo Pages công khai. Dashboard dùng Google Sign-In
và bản đồng bộ quyền theo lớp; không dùng cookie teacher backend chung.

Hợp đồng request/response nằm ở `docs/data-contract.md`; bản phác thảo PostgreSQL nằm ở `docs/schema.sql`.

## GitHub Pages

Trang được triển khai từ nhánh `main`, thư mục `/ (root)`. Repo chỉ chứa mã nguồn giao diện và tài liệu kỹ thuật; không đưa dữ liệu học viên hoặc credential vào lịch sử Git.
