# Màn hình duyệt ghép học viên

Đây là giao diện tĩnh dành cho giảng viên xác nhận đề xuất ghép học viên trong ERP với tài khoản Google Classroom. Repo không chứa dữ liệu học viên thật. Dữ liệu chỉ được tải từ API n8n sau khi người dùng nhập tên người duyệt và mã truy cập hợp lệ.

## Cách sử dụng

Mở trang GitHub Pages, nhập tên người duyệt và mã truy cập do quản trị viên cấp, rồi bấm **Kết nối**. Mã chỉ được giữ trong `sessionStorage` của tab hiện tại; đóng tab sẽ xóa mã khỏi trình duyệt.

## Kiến trúc được đề xuất

- Metabase: lớp đọc ERP, thông qua Apps Script/n8n; không để credential trong trình duyệt.
- Google Apps Script của tài khoản chủ lớp: đọc danh sách course và roster Classroom bằng quyền của giáo viên.
- PostgreSQL riêng cho tích hợp: lưu mapping đã duyệt, hàng chờ AI, lịch sử quyết định và snapshot roster.
- GitHub Pages: chỉ phục vụ HTML/CSS/JavaScript. API n8n xác thực bằng header và giới hạn CORS về origin GitHub Pages.

Mapping đã duyệt là nguồn dùng chung cho các workflow về bài tập, điểm danh và hành chính. Bản đầu dùng thuật toán ghép cục bộ theo email/tên, không gửi dữ liệu học viên sang mô hình AI bên ngoài. Giảng viên vẫn là người xác nhận cuối.

## Trạng thái triển khai

- PostgreSQL `mapping_db` đã có schema `mapping` và 37 phiếu duyệt của IC2172/IC2200.
- Workflow `Đồng bộ học viên IC2172 IC2200 để giảng viên duyệt` đã chạy thử thành công và đang để `Inactive`.
- Workflow `API để giảng viên duyệt mapping học viên` đang hoạt động; mã sai bị chặn và CORS chỉ cho phép origin GitHub Pages.
- `config.js` đặt `DEMO_MODE: false` để giao diện tải dữ liệu thật sau khi xác thực.

## Vận hành API thật

Khi cấp hoặc xoay mã truy cập, gửi mã cho giảng viên qua kênh riêng; không ghi mã vào repo, URL hoặc tài liệu công khai. Workflow đồng bộ dữ liệu nguồn vẫn để `Inactive` và chỉ chạy khi cần làm mới dữ liệu ERP/Classroom.

Không đặt mật khẩu Metabase, mật khẩu PostgreSQL, API key hoặc token vào repo. Mã truy cập hiện là quyền dùng chung; tên người duyệt là dữ liệu audit do người dùng nhập, chưa phải đăng nhập Google xác minh danh tính.

Hợp đồng request/response nằm ở `docs/data-contract.md`; bản phác thảo PostgreSQL nằm ở `docs/schema.sql`.

## GitHub Pages

Trang được triển khai từ nhánh `main`, thư mục `/ (root)`. Repo chỉ chứa mã nguồn giao diện và tài liệu kỹ thuật; không đưa dữ liệu học viên hoặc credential vào lịch sử Git.
