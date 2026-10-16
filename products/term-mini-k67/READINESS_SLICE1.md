# K67 làm quen Listening trước thi

Lát đầu: đăng nhập theo roster/ghi nhớ hiện có → xác nhận máy/tai nghe → nghe mẫu → lưu/nộp → kết quả → reload phục hồi. Route Pages `term-tests/lam-quen-k67/`; API `/api/k67-readiness/v1/`. Chưa phát hành production.

Theo phản hồi mới nhất của Đức, giữ nguyên phòng chờ Listening và preview của bài thi thật. Không tích hợp bộ kiểm mới vào đó trong phạm vi này. Không có gửi thông báo hoặc dashboard hỗ trợ; học viên liên hệ giảng viên qua chat hoặc trực tiếp.

## Ranh giới dữ liệu và đề

- Nội dung mẫu tự soạn về câu lạc bộ tưởng tượng; WAV giọng đọc SAPI ngoại tuyến. Không lấy audio, câu hỏi hoặc đáp án từ đề thật.
- Token `k67r1_…` và bảng `assessment.k67_readiness_session` độc lập. Token thử không có dạng UUID mà API thi hiện hành nhận. API thử không gọi bộ chấm, Portal, n8n hoặc mở phiên thi thật.
- Kho audio dùng helper mã hóa hiện có với scope API/slug/token riêng. Chỉ ciphertext ở IndexedDB; khóa ở RAM và lấy lại qua API sau xác thực. Bản mã hỏng bị bỏ trước lần tải lại.
- Server đối chiếu danh tính trong roster K67 và phạm vi lớp. Bộ nhớ chọn tên dùng lại `shared/student-memory.js`; không nâng mức xác thực thành mật khẩu/Google và không coi UUID đã nhớ là quyền truy cập.
- Ghi nháp có revision và kiểm xung đột; nộp đọc bản đã lưu, chống gửi lặp/đồng thời. Mất phản hồi nộp được đối chiếu bằng đọc lại phiên.

## Chuẩn bị bật sau khi được phép

Không tự chạy các bước này trên production. Phải áp `db/013-readiness.sql` vào đúng DB K67, cấu hình `K67_READINESS_ENABLED=true` và `K67_READINESS_CLASSES` là danh sách lớp được chọn, phân cách bằng dấu phẩy. Mặc định cờ `false`, danh sách rỗng: chưa mở bài làm quen.

Asset giọng đọc nằm tại `src/readiness-assets/listening-v1.wav`, được đóng cùng source backend. Thay nội dung cần tăng phiên bản bộ mẫu và kiểm lại cache/nháp; không ghi đè file đề thi để làm mẫu. Không có khóa bí mật mới hardcode; khóa phiên thử và audio được dẫn xuất có mục đích riêng từ khóa K67 đã cấu hình.

Phiên thử có hiệu lực 7 ngày. Chưa thêm lịch xóa record; retention/dọn dữ liệu phải được xác định trước phát hành thật. Reading/Writing chưa nằm trong lát này, UI ghi rõ “Chưa thử”.

## Kiểm lại

`node --test test/readiness.test.js` kiểm HTTP/SQL/crypto và 120 phiên chung IP trên PostgreSQL nhúng. Muốn kiểm đúng PostgreSQL native bằng role `k67_app`, dùng fixture local đã xác nhận với `K67_ORDER_NATIVE_URL=postgres://k67_fixture_admin@127.0.0.1:55468/postgres` và `K67_ORDER_NATIVE_CONFIRM=local-synthetic-20261014`; helper chỉ tạo/xóa DB ngẫu nhiên của lượt kiểm, không trỏ VPS.

Các lệnh nhận request giả và ghi vào DB thử; kiểm mở lại, lưu/xung đột, nộp, hết hạn/thu quyền, giải mã/hash và token sai mục đích. Khi lỗi, native runner trả failed; không thay bằng thông báo giao diện thành công.

Chrome/Edge có hành trình headed dùng server/SQL local: nghe hết 89,53 giây ở tốc độ 1×, nhập/sửa/lưu, reload dùng cache, ngăn hai tab, nộp/xem kết quả/reload; có ca mất ACK mở/nháp/nộp, offline, quota và ciphertext hỏng. Giao diện một dòng ở 1440/390 px; 390 px là cửa sổ Windows, không phải nghiệm thu điện thoại. Không dùng kết quả automation để nhận đã có người nghe qua tai nghe vật lý.

Bằng chứng riêng tư trên máy Đức: `E:/Codex-Data/k67-device-acceptance-20261016/readiness/`. Tài liệu kết quả chỉ vào kho riêng tư; không đưa tên người học hoặc bộ đề thật vào Git public.

## Quay lui

Cờ hiện tại tắt toàn tuyến làm quen, chưa có chế độ chỉ ngừng nhận lượt mới. Vì vậy chỉ tắt khi không còn lượt làm quen đang hoạt động hoặc đã thông báo rõ thời điểm dừng. Không xóa DB/bảng để quay lui. Feature mặc định tắt và route/state riêng; không sửa hay reset bài thi thật. Chưa thực hiện thao tác quay lui trên production.
