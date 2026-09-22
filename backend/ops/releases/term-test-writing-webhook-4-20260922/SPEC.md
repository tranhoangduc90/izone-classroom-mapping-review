# Khôi phục chấm Writing ngay với tối đa bốn luồng

## Kết quả người dùng nhìn thấy

Khi học viên nộp Writing Term Test, backend lưu bài và job trước, sau đó gửi tín hiệu đánh thức workflow. Hệ thống có thể giữ tối đa bốn job chấm trên toàn bộ các lớp; mỗi execution n8n vẫn chỉ nhận một job. Khi đủ bốn suất, bài mới nằm nguyên trong hàng chờ và được đánh thức lại khi một suất được trả.

## Phạm vi thay đổi

- Thêm lại bộ thông báo webhook đã được nghiệm thu ngày 09/09/2026.
- Đưa giới hạn bốn job và khóa cấp việc vào source chuẩn để các lần phát hành sau không làm mất hành vi này.
- Giữ lịch kiểm dự phòng năm phút trong backend. Trong 24 giờ đầu sau phát hành, workflow lịch n8n hiện có vẫn được giữ nguyên làm lớp an toàn bổ sung.
- Không đổi workflow n8n, database, model chấm, rubric, bài viết, mapping Portal hoặc frontend.
- Gói production kế thừa image quyền admin hiện tại và chỉ thay `server.js`, `term-test-writing-grading.js`, `term-test-writing-notifier.js`.

## Cách dữ liệu đi qua hệ thống

Thông báo chỉ mang `{ "kind": "term_test_writing_ready" }`, không mang bài làm, token học viên hoặc danh tính. Workflow xác thực tín hiệu rồi gọi API claim với `limit=1`; database khóa transaction, đếm lease còn hiệu lực và chỉ cấp việc khi toàn hệ thống còn dưới bốn job. `jobId`, `runKey`, `workerId` và khóa idempotency giữ nguyên xuyên suốt chấm, thu kết quả và thử lại.

## Cổng phát hành

Chưa thay đổi production trong giai đoạn chuẩn bị này. Trước khi phát hành phải đồng thời đạt: regression RED/GREEN, full suite, image ứng viên chạy ở cổng tạm với notifier tắt, hàng hiện tại không có job `processing`, không có lớp đang thi, và có xác nhận riêng của Đức. Sau phát hành phải đọc lại hash ba file, health/ready/version, log notifier, số job processing và execution webhook.

## Hoàn tác

Giữ image `izone-term-test-backend:20260922.1-admin-access`. Nếu readback mới sai, chuyển compose về image này; không xóa job hoặc sửa database. Workflow lịch năm phút vẫn hoạt động nên bài đang chờ không mất.
