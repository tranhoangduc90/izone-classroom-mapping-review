# Màn hình duyệt ghép học viên

Đây là giao diện tĩnh dành cho giảng viên xác nhận đề xuất ghép học viên trong ERP với tài khoản Google Classroom. Repo không chứa dữ liệu học viên thật. Backend PostgreSQL và hai workflow n8n đã được tạo; giao diện vẫn để chế độ xem thử cho tới khi quản trị viên kích hoạt API và GitHub Pages.

## Cách chạy bản xem thử

Mở `index.html` trên trình duyệt. Nếu trình duyệt chặn một số tính năng khi mở trực tiếp từ file, chạy máy chủ tĩnh trong thư mục này bằng một công cụ có sẵn trên máy, rồi mở địa chỉ localhost.

Ở chế độ xem thử, các nút chỉ thay đổi trạng thái trên màn hình. Khi chuyển `DEMO_MODE` thành `false`, trang yêu cầu tên người duyệt và mã truy cập rồi mới gọi API.

## Kiến trúc được đề xuất

- Metabase: lớp đọc ERP, thông qua Apps Script/n8n; không để credential trong trình duyệt.
- Google Apps Script của tài khoản chủ lớp: đọc danh sách course và roster Classroom bằng quyền của giáo viên.
- PostgreSQL riêng cho tích hợp: lưu mapping đã duyệt, hàng chờ AI, lịch sử quyết định và snapshot roster.
- GitHub Pages: chỉ phục vụ HTML/CSS/JavaScript. API n8n xác thực bằng header và giới hạn CORS về origin GitHub Pages.

Mapping đã duyệt là nguồn dùng chung cho các workflow về bài tập, điểm danh và hành chính. Bản đầu dùng thuật toán ghép cục bộ theo email/tên, không gửi dữ liệu học viên sang mô hình AI bên ngoài. Giảng viên vẫn là người xác nhận cuối.

## Trạng thái triển khai

- PostgreSQL `mapping_db` đã có schema `mapping` và 37 phiếu duyệt của IC2172/IC2200.
- Workflow `Đồng bộ học viên IC2172 IC2200 để giảng viên duyệt` đã chạy thử thành công và đang để `Inactive`.
- Workflow `API để giảng viên duyệt mapping học viên` đã kiểm tra tải hàng chờ, chặn mã sai và kiểm tra giao dịch quyết định bằng rollback; workflow vẫn `Inactive`.
- `config.js` vẫn đặt `DEMO_MODE: true` để không gọi API production trước khi được phê duyệt.

## Khi nối API thật

Để mở bản thật:

1. Kích hoạt workflow API trên n8n sau khi đã được phê duyệt production.
2. Đặt `DEMO_MODE: false` trong `config.js`.
3. Bật GitHub Pages. Nếu repo phải chuyển sang public, kiểm tra lại toàn bộ lịch sử Git trước.
4. Cấp mã truy cập cho giảng viên qua kênh riêng; không ghi mã vào repo hoặc URL.

Không đặt mật khẩu Metabase, mật khẩu PostgreSQL, API key hoặc token vào repo. Mã truy cập hiện là quyền dùng chung; tên người duyệt là dữ liệu audit do người dùng nhập, chưa phải đăng nhập Google xác minh danh tính.

Hợp đồng request/response nằm ở `docs/data-contract.md`; bản phác thảo PostgreSQL nằm ở `docs/schema.sql`.

## GitHub Pages

Trong GitHub, vào `Settings → Pages`, chọn `Deploy from a branch`, nhánh `main`, thư mục `/ (root)`, rồi lưu. Nếu repo private không có Pages theo gói GitHub hiện tại, có thể giữ repo private và triển khai cùng nội dung trên một máy chủ tĩnh có đăng nhập; không chuyển repo public khi trong đó đã có dữ liệu thật.
