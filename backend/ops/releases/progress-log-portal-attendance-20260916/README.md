# Phát hành Progress Log IC2305 · Writing 1 và điểm danh Portal

## Phạm vi

- Chuyển assignment Reading 1 & Listening 1 từ buổi 2 sang đúng buổi 4, giữ nguyên bài đã nộp.
- Phát hành assignment Writing 1 cho buổi 2.
- Phiếu đủ nội dung xếp job ghi PRESENT sang Portal sau transaction nộp bài.
- Worker chỉ claim `sync_portal_attendance`; job phân tích khác không bị tiêu thụ nhầm.

## Cổng an toàn

1. Backup có marker VERIFIED và checksum bản sao ngoài VPS khớp.
2. Migration `202609160003`–`202609160005` có ledger/readback; quyền đọc tài khoản duyệt chỉ gồm email và trạng thái.
3. n8n dry-run `commit=false` tìm đúng lớp, học viên và buổi mà không ghi Portal.
4. Backend test, Progress Log Pages test, health và readback assignment đều đạt.

## Lượt thử có chủ đích

Ngày 16/09, một lượt nộp thử Writing 1 buổi 2 được nhập thay học viên thật với nhãn
`THỬ NGHIỆM HỆ THỐNG` trong các câu tự luận. Buổi 2 theo lịch Portal là 17/09;
ô điểm danh được ghi để kiểm luồng, không chứng minh học viên dự buổi học.
Không tự xóa hoặc hoàn nguyên khi chưa có quyết định của Đức. Trước khi dùng dữ
liệu để nhận xét học tập, phải loại rõ lượt thử khỏi phân tích hoặc xử lý hoàn nguyên.
Job phân tích của đúng bài thử được giữ ở `review_required` với mã
`SYNTHETIC_TEST_SUBMISSION_HOLD` để không đưa câu trả lời giả vào nhận xét học tập;
job đồng bộ Portal đã hoàn tất. Bản ghi bài, checkpoint và điểm danh chưa bị xóa.

## Rollback

Dựng lại `mapping-review-api` bằng image `izone-term-test-backend:20260916.1-ic2305`.
Không xóa assignment hoặc migration; job chưa hoàn tất giữ trong hàng đợi để forward-fix.

## Bổ sung: xác nhận có mặt thủ công từ dashboard

- Khi GV chọn **Có mặt** và nhập lý do, API ghi trạng thái/audit và tạo job Portal trong cùng câu lệnh database. Job mang ID của sự kiện xác nhận, không giả làm bài nộp của học viên.
- Hàng đợi xử lý sau khi API đã trả lời. Dashboard hiển thị đang chờ, đang thử lại, đã ghi nhận hoặc cần kiểm tra xung đột.
- Workflow chỉ ghi `PRESENT` vào đúng ô lớp–học viên–buổi nếu ô đó trống; nếu Portal đã có trạng thái khác thì dừng `review_required`, không tự ghi đè. Nếu đã là `PRESENT`, coi là hoàn tất idempotent.
- **Chờ xác nhận** và **Không đủ điều kiện** chỉ là trạng thái nội bộ Progress Log; không ánh xạ chúng thành mã vắng của Portal khi chưa có quy tắc nghiệp vụ được xác minh. Khi cần đổi một ô Portal đã có trạng thái, GV thao tác trực tiếp trên Portal.
- Trước khi phát hành: backup workflow hiện hành, so sánh diff, kiểm thử `commit=false` đúng lớp/học viên/buổi, kiểm thử live bằng tài khoản thử được phê duyệt, rồi readback cả dashboard và Portal. Không dùng học viên thật để test mặc định.
