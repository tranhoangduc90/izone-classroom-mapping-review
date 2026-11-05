# Progress Log: giới hạn quyền xem khóa 56 theo lớp đang học

Yêu cầu ngày 05/11/2026: Thủy chỉ xem các lớp khóa 56 đang diễn ra.

Quyền `learning.progress_log_course_viewer` dùng trạng thái ERP `on_going` và ngày bắt đầu không sau ngày hiện tại tại Việt Nam. Danh sách và các đường đọc lớp/phiếu cùng áp dụng điều kiện này, kể cả lớp có phân công giảng dạy cũ. Lớp hoàn thành, hủy, chưa mở hoặc thiếu ngày bắt đầu bị từ chối với HTTP 403. Không xác minh được ERP thì trả HTTP 503; danh mục được làm mới theo cache hiện có tối đa 60 giây.

Quản trị Progress Log, giáo viên không có quyền xem mở rộng khóa 56 và phân công của Thủy ngoài khóa 56 giữ phạm vi cũ. Không đổi quyền soạn/duyệt nội dung, schema, bài học viên, điểm, điểm danh, phiên Google hoặc giao diện.

## Kiểm chứng

- Bộ hồi quy `test/learning-class-policy-active-course.test.js` kiểm danh sách, lớp được phân công cũ, link trực tiếp, chi tiết phiếu, trạng thái tương lai/thiếu ngày, ERP lỗi, cache hết hạn và phạm vi người khác.
- Cùng bộ hồi quy thất bại trên mô-đun live trước thay đổi và đạt trên bản sửa.
- Toàn bộ nhóm Learning và hồi quy thời hạn phiên: 339/339 ca đạt, không skip, trên 80 file kiểm. PostgreSQL riêng dùng role ứng dụng và dữ liệu giả; lỗi kết nối hàng loạt ở lượt đầu đã được xác định tại hàng đợi tunnel thử, lượt cuối dùng hàng đợi đủ lớn và đạt cả các ca đó.
- Bản image ứng viên chỉ thay `src/learning-class-policy.js`; 146 file nguồn còn lại và hành vi phiên đăng nhập khớp image đang chạy.
- Đọc dữ liệu production ở chế độ chỉ đọc: tại mốc kiểm, 30/276 lớp 56 được xem, 246 lớp khác bị từ chối. Một lớp được phân công ngoài khóa 56 và phạm vi quản trị/giáo viên khác giữ nguyên. Số lớp thay đổi tự động theo ERP.
- Không nộp thử bài học viên hoặc ghi Portal để kiểm quyền. Phiên Google thực tế của Thủy chưa được quan sát.

## Phát hành và quay lui

Dựng image từ đúng image live, chỉ thay mô-đun đã kiểm. Giữ nguyên toàn bộ environment, mounts, cấu hình khởi động, network và HostConfig; xác nhận cấu hình/consumer điểm danh còn nguyên. Đọc lại hash mô-đun, quyền trên dữ liệu thật và số hàng nghiệp vụ sau chuyển.

Biên nhận riêng: `E:/wt/progress-thuy-active56-20261105/`. Bản sao cấu hình và container trước chuyển được giữ tại `/opt/izone-progress-thuy-active56-20261105/backup-<UTC>/` và `mapping-review-api-before-thuy-active56-20261105`. Quay lui bằng container đó sau khi kiểm không có release mới xen vào; giữ dữ liệu hiện tại, không phục hồi dump cũ. Quay lui này khôi phục cả phạm vi xem rộng trước yêu cầu.
