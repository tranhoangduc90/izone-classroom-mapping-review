# Progress Log IC2305: theo dõi từng phần và điểm danh Portal

## Trạng thái ngày 16/09/2026

- API production: `izone-term-test-backend:20260916.3-progress-log-live-tracking`, health `healthy`, bản public `1.8.7-k56-live-tracking`.
- GitHub Pages: commit `6cc5fcd`, workflow Pages hoàn tất thành công. Dashboard đặt **Theo dõi lớp** trước **Tạo phiếu**.
- Dashboard tự đọc lại trạng thái mỗi 8 giây khi tab đang mở; mỗi học viên có trạng thái riêng cho từng phần: chưa mở, chưa nộp, đang nhập hoặc đã nộp. Đây là cập nhật gần thời gian thực, không phải kết nối liên tục kiểu WebSocket.
- Xác nhận **Có mặt** thủ công tạo job Portal cùng transaction với sự kiện điểm danh; dashboard hiện trạng thái đồng bộ. Workflow chỉ ghi `PRESENT` nếu ô Portal còn trống; trạng thái khác chuyển kiểm tra thủ công.
- n8n workflow `gnk0f2qZlKr1mIES` đang active, vẫn dùng webhook cũ; thêm contract `LearningPortalAttendanceOverrideJobV1`.

## Bằng chứng kiểm chứng

- Backup PostgreSQL production được tạo trước migration và sao ra ổ E:, dung lượng 7.877.952 byte, SHA-256 `d83a4b35917b2dae0b3419382434986d75e411b13905ee4fd578beadd286f342`.
- Index `idx_learning_portal_attendance_student_unit` đã được đọc lại từ PostgreSQL.
- Backend: 17/17 ca mục tiêu đạt; frontend: 7/7 ca mục tiêu đạt. Bộ test backend toàn phần còn một fixture Term Test cũ không liên quan thay đổi này.
- Dashboard SQL chạy bằng role API trên hai phiếu IC2305 buổi 2 và 4: mỗi phiếu 18 học viên, 3 phần; checkpoint đọc được. Không xuất tên hoặc nội dung học viên vào log phát hành.
- Dry-run `commit=false` của contract override trả `preview`, đủ bốn identity khớp; không ghi Portal. Chưa thực hiện một lần xác nhận thủ công có ghi thật cho học viên production trong đợt kiểm này.

## Hoàn nguyên nếu cần

- Backend: dựng lại đúng chuỗi Compose đang chạy nhưng bỏ overlay của release này; image nền là `izone-term-test-backend:20260916.2-progress-log-attendance`.
- n8n: dùng bản backup workflow trước cập nhật lưu trong `output/n8n-backups` của workspace phát hành, đọc lại active/webhook sau khi hoàn nguyên.
- Pages: revert commit `6cc5fcd` bằng một commit mới, không force-push.
- Không tự xóa migration, checkpoint, sự kiện điểm danh hoặc job đã tạo; giữ lại để đối soát và sửa tiếp nếu cần.
