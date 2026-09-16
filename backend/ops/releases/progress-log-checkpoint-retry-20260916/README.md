# Phát hành sửa lần gửi lại checkpoint — 16/09/2026

## Mục đích và phạm vi

Khi học viên nộp một phần thành công nhưng không nhận được phản hồi, giảng viên có thể đã đóng phần trước lúc máy học viên thử lại. Bản cũ trả `BLOCK_NOT_OPEN` dù checkpoint đã lưu. Bản mới tra checkpoint theo khóa chống trùng và so hash nội dung trước khi xét trạng thái phần/attempt. Lần gửi lại đúng trả biên nhận cũ; nội dung khác hoặc checkpoint mới sau khi đóng vẫn bị chặn.

Chỉ thay `/app/src/learning-service.js` trong image API. Không migration, không sửa database, không đổi Portal/n8n/Pages hoặc các dịch vụ khác.

## Kiểm tra trước phát hành

- Source test: `npm test` đạt 144/144; `npm run check` đạt.
- Source đã chuyển lên VPS có SHA-256 `8d2eac2b72656ecc28f57b85c04c9fd16662f0bf1a2f4ba8e1285f7a33bc0f67`.
- Image nền `izone-term-test-backend:20260916.3-progress-log-live-tracking` healthy; image mới build từ đúng image nền và chỉ `COPY` một module.
- `deploy.sh --check` trả `COMPOSE_VALID`; image mới vượt `node --check` khi chạy cô lập, không có mạng.
- Trước đổi: bảng `learning` có 19 attempt, 13 submission, 14 checkpoint, 14 attendance record, 22 outbox job. Đây là số tổng, không chứa danh tính học viên.

## Đọc lại sau phát hành

- Image đang chạy: `izone-term-test-backend:20260916.4-progress-log-checkpoint-retry`, health `healthy`.
- API công khai `/mapping-api/health`: `ok=true`, version `1.8.8-k56-checkpoint-retry`, build SHA `dfd7fff6ac12d489865c6a98061a4be0d4a18ea5fed57f2723b4d82ebec69b26`.
- SHA-256 module trong container đúng bằng source đã kiểm. Tài nguyên API giữ 0,5 CPU và 256 MB RAM; restart count 0, OOM false.
- Sau đổi, năm số tổng database trên lần lượt là 19, 13, 14, 14, 22. Không tạo bài làm hoặc điểm danh thật để thử.
- `rollback.sh --check` trả `ROLLBACK_COMPOSE_VALID`; image nền còn trên VPS.

## Quay lại nếu cần

Chạy `bash /opt/izone-progress-log-checkpoint-retry-20260916/rollback.sh` trên VPS. Script chỉ bỏ overlay của release này và dựng lại API từ image nền. Nó không xóa dữ liệu nộp bài, điểm danh hoặc hàng đợi. Sau đó đọc lại health, image và số tổng dữ liệu.

## Kiểm thử gửi lại bằng dữ liệu thật

- Chọn một checkpoint đã lưu của học viên lớp IC2305, buổi 2, sau khi học viên đã nộp cả phiếu. Chỉ gửi lại đúng `attemptToken`, mã checkpoint, khóa chống trùng và nội dung cũ; nội dung lưu sẵn khớp hash. Không đưa danh tính hoặc câu trả lời ra khỏi VPS.
- API production trả HTTP 201, `replayed=true` và đúng biên nhận/thời điểm đã lưu.
- Đối chiếu ngay trước–sau: checkpoint 15, bài nộp 13, điểm danh 14, sự kiện điểm danh 11, job 22; đều không đổi. Checkpoint của đúng phiên vẫn chỉ có một bản; trạng thái phiên và hash bản ghi điểm danh cũng không đổi. Vì không sinh job mới, phép thử không kích hoạt gửi lại điểm danh lên Portal.
- Đây là phép thử nhánh gửi lại **sau khi nộp cả phiếu**. Chưa thử đóng một phần đang mở của lớp thật, vì thao tác đó ảnh hưởng toàn lớp. Ca đóng phần đã được kiểm bằng test tự động.

Mã nguồn bản phát hành đã được commit ở `c038ea9` và đẩy lên nhánh `feat/progress-log-portal-attendance-20260916` của repo backend; chưa gộp vào `main`.

Giới hạn còn lại: việc đồng bộ điểm danh Portal thật và tải 1.000 người là các cổng nghiệm thu khác, không thuộc bản vá này.
