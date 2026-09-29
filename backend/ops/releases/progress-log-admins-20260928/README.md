# Cấp quyền quản trị riêng cho Progress Log

## Kết quả cần thấy

Bốn đồng nghiệp Đức nêu đăng nhập bằng đúng tài khoản Google của mình, thấy mọi lớp trong trang giảng viên Progress Log, tạo và công bố phiếu cho các lớp đó. Quyền quản trị Mapping, Term Test và Speaking không được mở rộng. Phiếu có điểm vẫn phải có người duyệt thứ hai hoặc quyền lead chuyên môn của đúng khóa.

Phạm vi nghiệm thu là `small_complete`: bốn tài khoản, mọi lớp Progress Log, quy tắc thu hồi quyền, và không lan sang sản phẩm khác. Không cấp GitHub, SSH hay quyền triển khai máy chủ; không thay đổi nội dung bài hoặc điểm danh học viên.

## Trạng thái trước phát hành

Kiểm tra production chỉ đọc ngày 28/09/2026: cả bốn email đã có tài khoản `active`, vai trò `teacher`, cờ xem mọi lớp toàn hệ thống đều `false`; một tài khoản đã gắn Google subject. Bảng `learning.progress_log_admin` chưa tồn tại. Bản source cũ không có quyền scoped này. Chưa có thao tác ghi production trong đợt cấp quyền.

## Thiết kế vận hành ngắn

- Đường đi: đồng nghiệp đăng nhập Google → API xác thực tài khoản → truy vấn Progress Log kiểm quyền riêng → dashboard hiện lớp và cho tạo/công bố phiếu → database lưu assignment. Không có bước n8n hay Portal trên đường cấp quyền.
- Tải: thêm bốn tài khoản quản trị trên hệ thống dùng chung khoảng 110 lớp × 15 học viên theo hợp đồng Progress Log hiện có. Quyền được kiểm bằng khóa email trong PostgreSQL; không thêm lời gọi dịch vụ ngoài. Trang cần hiện lớp trong vài giây như hiện nay; nếu danh sách chậm, đo truy vấn trước khi tối ưu.
- Giới hạn: chỉ tài khoản `active` và bản ghi quyền `active` mới được phép. Sai quyền hoặc thiếu bảng làm yêu cầu thất bại rõ ràng. Quyền tự duyệt phiếu có điểm vẫn độc lập theo khóa.
- Phục hồi: migration trước bản API mới; cấp bốn quyền trong một transaction. Nếu lỗi, rollback transaction. Nếu sau phát hành phải thu hồi, chạy `rollback.sql`, giữ tài khoản và phân công lớp vốn có; có thể quay lại image API cũ. Không xóa bảng trong lúc còn container dùng nó.
- Theo dõi: đọc lại bốn tài khoản và quyền, kiểm trang chọn lớp với tài khoản đồng nghiệp, lỗi API, health, hàng chờ và kết quả điểm danh Portal theo cổng Progress Log. Đức phụ trách quyết định xử lý nếu có lệch quyền hoặc điểm danh.

## Thứ tự phát hành cần duyệt riêng

1. Khóa bản image và cấu hình container live đã xác minh; backup database và image/compose, ghi cách quay lại. Đối chiếu sự hiện diện và đích của `LEARNING_ENABLED`, `LEARNING_DATABASE_URL`, `LEARNING_ATTENDANCE_SYNC_URL`, `ERP_SYNC_SECRET` mà không in secret. Kiểm consumer `sync_portal_attendance`, job quá lease, trạng thái hàng chờ và guard fail-fast ở source chuẩn.
2. Áp dụng migration `202609280001_progress_log_admin_scope.sql` vào đúng `mapping_db`. Đọc lại bảng, khóa ngoại và quyền SELECT của `learning_api`.
3. Chạy `grant.sql` với chế độ dừng ở lỗi SQL trong transaction. Readback phải đúng bốn email, `teacher`, `active`, `can_access_all_classes=false`, quyền Progress Log `active`. SQL dừng nếu tài khoản nào đã có quyền rộng hoặc bị khóa; không tự sửa trạng thái bất thường.
4. Triển khai image API xây từ revision đã kiểm, giữ nguyên cấu hình điểm danh đã xác minh. Đọc lại health, image ID, các biến bắt buộc, worker và hàng chờ. Kiểm danh sách lớp qua phiên đăng nhập của ít nhất một đồng nghiệp, rồi tạo/công bố một phiếu chỉ khi có nội dung/lớp được Đức cho phép.
5. Sau chuyển bản, đối chiếu một ca điểm danh được phép đến outcome Portal và số hàng chờ. Nếu chưa có ca được phép, ghi `deployed_awaiting_validation`; không gọi tuyến điểm danh `verified`.

Các phép kiểm local: `npm run check`; `npm test` đạt 215/215 trên worktree của đợt này. Bản cập nhật production và kết quả nhìn thấy của đồng nghiệp vẫn chờ phát hành/readback.
