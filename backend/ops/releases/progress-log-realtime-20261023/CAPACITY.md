# Kết quả tải ứng viên V2.1 — 23/10/2026

Phạm vi cuối được chốt: **30 lớp ×18 học viên =540 người**. Đây là kết quả trong kho giả riêng, chưa phải readback production. Không ghi hoặc điểm danh thay học viên thật.

## Cấu hình và phép đo

- API Node24.19 từ image live đã ghim, giới hạn2CPU/2GiB; PostgreSQL16 riêng2CPU/768MiB, Learning pool15 và Mapping pool5. VPS dùng chung với các dịch vụ khác; quota không phải CPU dành riêng.
- Máy phát tải ở máy local, đi qua SSH loopback. HTTP gồm độ trễ mạng; hiệu chỉnh đồng hồ có RTT tốt nhất30ms. Không đưa cookie/khóa/hồ sơ người thật vào mô hình.
- Cookie giả đi qua chính truy vấn xác minh/gia hạn phiên; không giả gọi Google hoặc broker. Ba NAT giả, phiếu hai phần/ba câu phản hồi mở, khoảng5,8KB câu trả lời/người. Không đại diện cho mọi độ dài đề, loại câu hoặc thiết bị.
- Nháp mỗi10giây/người; thử một và hai tab/GV. Ca nộp dồn có540 người, mỗi người hai checkpoint rồi final trong cửa sổ30giây.
- Độ trễ tới GV ở bảng là từ `savedAt` DB tới lúc client nhận JSON, chưa phải đo trọn tới DOM. Mốc DB trước commit nên gồm phần transaction còn lại. Kiểm Chrome riêng đã giữ panel/nháp, không lỗi JS; không cộng hai phép đo để tạo một p95 đầu cuối giả.

## Bản cuối có gom revision theo transaction

| Ca | Lưu nháp p95 | Nộp phần / final p95 | DB → JSON GV p95 | Kết luận theo mục tiêu thử |
|---|---:|---:|---:|---|
|10 lớp ×18, một tab/GV|0,126s|—|0,970s|Đạt|
|30 lớp ×18, một tab/GV|0,363s|—|1,166s|Đạt|
|30 lớp ×18, hai tab/GV|1,284s|—|1,695s|Nháp vượt mục tiêu1s|
|30 lớp ×18, nộp dồn30s|—|4,837s /5,312s|4,789s|Vượt mục tiêu2s|

Không có HTTP lỗi, yêu cầu bị bỏ vì bận, bài còn chờ hoặc bài chưa tới người xem trong bốn pha. Đọc lại đủ540 submission,540 attendance record,540 attendance event và540 outbox job Portal; các mã bài đã được client quan sát đúng người. **Không chạy consumer ghi Portal**, nên các số đó không chứng minh Portal đã điểm danh.

Đã thử pool10/15/24 trên cùng quy mô; tăng pool không làm ca nộp dồn đạt2s. Các lượt được giữ riêng, không chọn lượt nhanh nhất để gọi là bảo đảm. Đã thử bỏ NOTIFY/quét revision chung500ms để chẩn đoán, vẫn chưa đạt; bản cuối giữ NOTIFY sau commit/LISTEN và đọc bù10s theo B. Bản gom transaction giảm ghi metadata lặp, có6/6ca PostgreSQL gồm đồng thời/rollback/quyền; chưa có bằng chứng nó một mình giải quyết được tải.

## Trạng thái phát hành

- Image ứng viên: `sha256:f46c29a6da172dc98307f3c5fcef8052b6b1195d5451be267d58ab71685edfed`, nền `sha256:58b2164729cdddc2883931b8f1508e1d435c31abe7829e37d3c8a4392150a2c7`.92/92ca API/auth/session/CORS/consumer trên chính image ứng viên đạt. Không cài thêm dependency production.
- Giữ overlay live của các sản phẩm khác và guard worker điểm danh. Chưa chạy migration, đổi Nginx, chuyển container thật hoặc bật SSE trên production tại mốc báo cáo này.
- Chưa đạt đều mục tiêu thử1s nháp/2s nộp/cập nhật ở toàn bộ ca30×18. Cần xử lý giới hạn hiệu năng hoặc chốt rõ mức độ trễ chấp nhận trước phát toàn bộ gói; không hạ ngưỡng để đổi kết quả cũ thành đạt.
- Nhịp autosave học viên vẫn5–12s khi ngừng gõ/max25–45s; chưa bật đề xuất2–3s/max10. Lưu cục bộ ngay không có nghĩa máy chủ đã nhận. Không hứa tốc độ từ phím gõ đến GV theo số DB → JSON trên.

Bằng chứng riêng tư được giữ trong hồ sơ task `progress-log-refresh-investigation-20261023` trên máy Đức: `load-coalesced2.log`, `v21-external-load-result.json`, các snapshot theo hash trong `load-runs/`, `v21-pg-coalesced2.log`, `v21-candidate-coalesced-tests.log` và kết quả/ảnh Chrome. Không đưa payload hoặc định danh thật vào Git.
