# Giữ bài khi có sự cố audio — lát 1 K67

Trạng thái: đã xây và kiểm local bằng dữ liệu giả; chưa đưa lên production. Phạm vi là Term Test 1/2 và Mini Test Buổi 5, cả Listening trước và Reading trước. Bảo vệ mới mặc định tắt.

## Hành vi

Khi học viên báo không nghe được hoặc player gián đoạn, trang giữ mốc nghe và bản đáp án hiện tại. API ghi một sự cố mở; mọi đường lưu thay đổi/nộp Listening đều bị chặn cho đến khi phục hồi. Mẫu thử âm thanh không chứa câu hỏi. Học viên xác nhận đã nghe được rồi tiếp tục; server chỉ đóng sự cố sau xác nhận player đã tiến triển.

Mỗi sự cố có một mã riêng và mã lần thử tiếp tục. Gửi lại do mất phản hồi không bù thêm; tổng bù dùng chung trần 900 giây hiện có. Khi vượt trần hoặc đã hết hạn trước lúc server nhận sự cố, giữ bài để giáo viên xử lý. Lát này chưa thêm thao tác giáo viên cấp thêm giờ/thi lại.

Lỗi API tiến độ khi audio vẫn chạy không mở sự cố hoặc dừng phát. Bài đã nộp không được tự mở lại. Client không mang mã phiên bị từ chối nếu đang có phiên protocol mới, để không tạo bài nộp tách khỏi phiên đang bảo vệ.

## Cấu hình và dữ liệu

- `K67_AUDIO_INCIDENT_ENABLED=false` là mặc định. Chỉ giá trị `true` mới nhận đăng ký `audioProtocolVersion: 1` cho phiên chưa bắt đầu. Phiên đã bắt đầu bằng protocol cũ không tự đổi giữa bài.
- Áp migration thêm `db/010-audio-incidents.sql` trước khi bật tính năng ở bất kỳ môi trường nào. Migration thêm trạng thái/revision vào session và bảng sự cố riêng; không sửa migration cũ hoặc dữ liệu bài đã nộp.
- Hai trigger bảo vệ thao tác ghi session/attempt kể cả handler tương thích cũ. `P6701` chuyển thành `409 AUDIO_INCIDENT_OPEN`; `P6702` thành `409 AUDIO_SESSION_REQUIRED`.
- Giao dịch sự cố khóa session, đọc thời gian sau khi đã lấy khóa. Nó không khóa attempt theo chiều ngược với nhánh Reading trước. Trigger nộp bài đọc lại session dưới khóa trước khi cho ghi.
- Không xóa bảng hoặc gỡ trigger khi còn phiên protocol mới đang hoạt động. Khi quay lui, ngừng nhận phiên mới, giữ server hiểu sự cố cho tới khi các phiên cũ đã kết thúc theo xử lý hợp lệ.

Đường POST dưới `/api/term-tests/:testSlug/session/`:

| Đường | Việc thực hiện |
|---|---|
| `audio-state` | Đọc trạng thái có quyền bằng mã phiên và generation nếu có |
| `audio-incident` | Ghi mốc, snapshot nháp, lý do và sự cố; cùng ID khác payload bị từ chối |
| `audio-resume` | `prepare` giữ sự cố mở; `confirm` kiểm lần thử/mốc rồi bù và đóng một lần |
| `audio-progress` | Giữ tương thích; playing/recovered cũ không thể đóng sự cố mới |

Response có `audioProtocolVersion`, `audioRevision`, `audioPhase`, `activeIncident`, `needsTeacher`, `canSubmit`, deadline và tổng bù. Trình duyệt loại phản hồi revision cũ trước mọi side effect.

## Kiểm local

Cần Node 24 và dependency đúng package-lock. Preview dùng database nhúng trong RAM, tên/đề/audio đều giả. Lệnh dưới nhận đường dẫn worktree frontend, dựng ứng dụng/API thật tại máy và mở cổng preview; lỗi hiện ở terminal. Không chạy lệnh deploy hoặc công cụ VPS.

```powershell
# Cài dependency đã ghim rồi mở bản thử với bảo vệ audio được bật.
npm ci --ignore-scripts --no-audit --no-fund
$env:K67_PREVIEW_PORT = '8895'
$env:K67_PREVIEW_AUDIO_SECONDS = '90'
$env:K67_PREVIEW_AUDIO_PROTECTION = 'true'
node tools/preview-exam-order.mjs '<đường dẫn worktree Pages>'
```

Test browser mới nằm ở repo Pages: `tests/k67-audio-incidents-browser.mjs`. Test tự mở preview ứng viên ở cổng ngẫu nhiên rồi đi UI/HTTP/SQL thật. `K67_BACKEND_FIXTURE_ROOT` chỉ định sản phẩm backend khi hai repo không ở cạnh nhau.

Test backend mới: `test/audio-incidents.test.js`. Helper mặc định dùng PGlite; cấu hình `K67_ORDER_NATIVE_URL` và `K67_ORDER_NATIVE_CONFIRM` chỉ chấp nhận PostgreSQL giả localhost:55468 đúng role. Native kiểm cạnh tranh dùng nhiều connection, không thay bằng pool mock. Full `npm test` còn cần fixture có marker cho các nhóm database/HTTP hiện có; không trỏ vào DB thật để làm test chạy.

## Bằng chứng và giới hạn

Lượt 15/10/2026: 226 ca backend đạt bằng các nhóm không trùng, có PostgreSQL 16, role thật, HTTP và `server.js`. 17 ca browser mới đạt, bao gồm sáu hành trình chính, mất mạng, reload giữ nháp không rỗng, lost ACK, phản hồi cũ, báo lỗi trong khi nộp và retry hữu hạn. Backend test bật/tắt flag cũng xác nhận mặc định tắt.

Review độc lập phát hiện ba race; cả ba đã sửa và kiểm lại. Toàn bộ raw log, cấu hình giả và báo cáo ghép kiểm nằm ngoài Git trong hồ sơ local của lát này. Không coi test local là bằng chứng âm thanh tới tai nghe thật hoặc production đã thay đổi.

Lưu bền audio mã hóa, một chủ phát giữa nhiều tab/thiết bị, quyền chọn đầu ra và kiểm 30 phút trên máy học viên thuộc các lát sau. Lát 1 chỉ lưu sự kiện chưa gửi/bản nháp theo phiên; reload vẫn cần mạng để xác thực và tải audio theo cơ chế hiện có.
