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

## Rollback

Dựng lại `mapping-review-api` bằng image `izone-term-test-backend:20260916.1-ic2305`.
Không xóa assignment hoặc migration; job chưa hoàn tất giữ trong hàng đợi để forward-fix.
