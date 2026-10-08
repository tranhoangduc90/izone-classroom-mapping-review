# Sửa nộp Progress Log và quyền database — 08/10/2026

## Vấn đề và phạm vi

Nộp cuối gọi `refreshSubmissionDeadline` sau nâng cấp tự khóa lúc 22:00. Role ứng dụng chưa được cấp UPDATE hai cột mới nên PostgreSQL trả 42501 và rollback bài, điểm danh, hàng chờ; checkpoint đã chấm vẫn còn. Nhiều người nộp cùng phút không phải điều kiện gây lỗi: bài đầu cũng thất bại. Test owner không kiểm được quyền ứng dụng.

Migration sửa `202610080001_submission_deadline_permissions.sql` chỉ cấp UPDATE `auto_submission_threshold_at` và `auto_submission_closes_at` cho `learning_api`. Giữ migration lịch sử và quyền bất biến của version/identity.

## Kết quả production đã đọc lại ngày 08/10

Đã phục hồi 14 bài đủ bằng chứng trước hạn qua service thật, giữ mã phục hồi cố định, thời gian xử lý thật và audit lý do. Readback có 14 submission, 14 attendance, 14 job hoàn tất và 14 operation Portal `synced` có `readback_at`. Sau chuyển limiter, cả 14 biên nhận đọc qua HTTPS trả 200/complete và các số đối soát vẫn đủ. Operation Portal được ghi trước lần chuyển limiter; không phải 14 lần ghi mới sau image.

Image `izone-progress-submit:20261008-fixed` có SHA `769e23a00388291b4d254fca32747badcbbad8bc6b83e3b4117558a09f391ed2`, healthy. Đối chiếu 66 module source và cấu hình container: chỉ routes đổi, 65 module khác giữ nguyên. Không sửa n8n workflow hay mở lại hạn chung. Backup/container trước chuyển giữ riêng để quay lui.

Tách quota: nộp cuối 6/phút/attempt, checkpoint 6/phút/attempt/block, đọc biên nhận 30/phút/attempt. Giữ giới hạn IP; đọc kết quả và nộp từng phần không lấy mất quota nộp cuối.

## Kiểm chứng

- PostgreSQL riêng, dữ liệu giả: service dùng `SET ROLE learning_api` trên mọi connection. Tái hiện thiếu quyền 42501, rollback đủ; cấp quyền rồi retry nhận đúng một bài.
- 20 người nộp đồng thời và retry: đúng 20 submission, 20 attendance, 20 job Portal; giữ mốc 22:00 và quyền không được sửa `form_version_id`.
- HTTP: kết quả vẫn đọc được sau khi hết quota nộp; phiếu 8 phần và retry vẫn nộp cuối được. Các ca này RED trên limiter cũ và GREEN trên bản sửa.
- Fixture Journey nhận schema đồng bộ hiện hành; fixture tải ghim giờ trước hạn để không phụ thuộc giờ máy. Không dùng fixture quản trị để chứng nhận quyền production.
- Full suite cuối đạt **357/357**, 69 file, không skip; image ứng viên 3/3 gồm auth 90/365 bằng HTTP thật/adapter fetch riêng cho test. Git integration ngày 09/10 dùng lại bằng chứng 08/10 vì source, migrations và toàn bộ test không đổi; chỉ bổ sung tài liệu kết quả. Không phát hành lại API chỉ để nhập Git.

## Source và phát hành

Branch task tích hợp hai nhóm source **đã chạy trên production**: Journey/nhận xét và binding/auto-close, trước khi áp bản sửa. Đây là đối chiếu dependency đang chạy; không triển khai tính năng mới trong lần sửa này.

Image sửa được dựng từ image live đã ghim; chỉ thay `src/learning-routes.js`, giữ 65 module khác, cấu hình, consumer và đích điểm danh. Không dựng API từ main cũ để tránh ghi đè Speaking/Lark hoặc module chưa tích hợp.

Backup/recovery/audit có dữ liệu riêng tư nằm ngoài Git: `E:/Codex-Data/progress-log-investigations/2026-10-08-ic2304-session6/`. Báo cáo kết quả trong thư mục này chứa readback cuối và trạng thái Git/image. Không coi báo cáo điều tra trước sửa là trạng thái live mới.

## Quy tắc dùng lại

Khi đổi schema/quyền/transaction nộp: kiểm bằng role ứng dụng, kiểm đồng thời/retry/rollback/hạn và đọc lại Portal. Phiếu mới chỉ thay nội dung không cần dựng lại backend, nhưng phải kiểm API/quyền hiện hành. Skill `build-progress-log-webapp` dẫn tới `references/submission-permissions-and-recovery.md` để giữ bài học này.

Quay lui limiter bằng container đã lưu; giữ GRANT hai cột vì nó khắc phục lỗi trên cả source cũ. Không xóa bài/điểm danh đã phục hồi hoặc giả mốc nộp. Main/remote và production là trạng thái độc lập, cần quyền riêng để tích hợp Git.
