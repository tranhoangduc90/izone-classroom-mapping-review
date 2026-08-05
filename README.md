# Màn hình duyệt ghép học viên

Đây là giao diện tĩnh dành cho giảng viên xác nhận đề xuất ghép học viên trong ERP với tài khoản Google Classroom. Repo không chứa dữ liệu học viên thật và hiện chạy ở chế độ xem thử.

## Cách chạy bản xem thử

Mở `index.html` trên trình duyệt. Nếu trình duyệt chặn một số tính năng khi mở trực tiếp từ file, chạy máy chủ tĩnh trong thư mục này bằng một công cụ có sẵn trên máy, rồi mở địa chỉ localhost.

Các nút `Duyệt` và `Từ chối` chỉ thay đổi trạng thái trên màn hình. Chúng chưa ghi vào Metabase, ERP hay PostgreSQL.

## Kiến trúc được đề xuất

- Metabase: lớp đọc ERP, thông qua Apps Script/n8n; không để credential trong trình duyệt.
- Google Apps Script của tài khoản chủ lớp: đọc danh sách course và roster Classroom bằng quyền của giáo viên.
- PostgreSQL riêng cho tích hợp: lưu mapping đã duyệt, hàng chờ AI, lịch sử quyết định và snapshot roster.
- GitHub Pages: chỉ phục vụ HTML/CSS/JavaScript. API thật phải là máy chủ trung gian có xác thực giảng viên.

Mapping đã duyệt là nguồn dùng chung cho các workflow về bài tập, điểm danh và hành chính. AI chỉ tạo đề xuất cùng điểm tin cậy/lý do; giảng viên vẫn là người xác nhận cuối.

## Khi nối API thật

Chỉnh `config.js` ở môi trường triển khai để đặt `API_BASE_URL` và đặt `DEMO_MODE: false`. Không đặt mật khẩu Metabase, mật khẩu PostgreSQL, API key hoặc token vào repo. API cần kiểm tra danh tính giảng viên, quyền theo lớp, chống giả mạo yêu cầu và ghi lịch sử duyệt.

Hợp đồng request/response nằm ở `docs/data-contract.md`; bản phác thảo PostgreSQL nằm ở `docs/schema.sql`.

## GitHub Pages

Trong GitHub, vào `Settings → Pages`, chọn `Deploy from a branch`, nhánh `main`, thư mục `/ (root)`, rồi lưu. Nếu repo private không có Pages theo gói GitHub hiện tại, có thể giữ repo private và triển khai cùng nội dung trên một máy chủ tĩnh có đăng nhập; không chuyển repo public khi trong đó đã có dữ liệu thật.
