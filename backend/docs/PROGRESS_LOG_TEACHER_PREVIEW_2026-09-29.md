# Xem thử Progress Log như học viên — kế hoạch phát hành

## Phạm vi small_complete

Giảng viên đã đăng nhập chọn một phiếu đã phát hành trong dashboard và bấm **Xem thử như học viên**. Trang thử mở đúng phiên bản nội dung và trạng thái các phần của phiếu đó, cho nhập, lưu nháp, nộp từng phần, xem phản hồi được phép công bố, nộp cuối và **Làm lại**. Một nút trên dashboard dùng được cho mọi buổi; không tạo sáu hồ sơ demo cố định cho mỗi phiếu mới.

Không thay nội dung hoặc câu trả lời của học viên thật; không tạo bài trong lớp thật; không phát hành phiếu đang soạn; không thay chức năng điểm danh Portal. Hai demo cũ tiếp tục mở được qua link cũ nhưng sẽ được ẩn khỏi danh sách phiếu thông thường sau khi đường thử mới đạt kiểm chứng.

## Ranh giới và hành trình

Dashboard kiểm quyền giảng viên đối với lớp của phiếu đang chọn, rồi cấp một vé thử ngắn hạn gắn với đúng assignment/version. Dịch vụ demo nhận vé, đọc bản phiếu đã phát hành qua kết nối máy chủ được bảo vệ, tạo lượt trong kho dữ liệu mẫu riêng. Giao diện học viên dùng cùng component hiện hành; banner luôn ghi rõ đây là bản thử. Lệnh **Làm lại** tạo lượt mới và vô hiệu lượt cũ. Không nhận link học viên công khai làm quyền tạo demo.

Kho thử không kết nối database lớp thật, Portal, AI hoặc n8n. Dữ liệu nháp, câu trả lời, chấm và trạng thái thử chỉ nằm trong kho này; kiểm trực tiếp database thật trước/sau canary để chứng minh không có attempt, submission, attendance hay outbox mới. Đáp án chấm chỉ đi từ API thật sang dịch vụ demo qua khóa máy chủ, không nằm trong Pages hoặc phản hồi công khai trước thời điểm được phép hiện.

## Thiết kế vận hành

- **Đường đi quan trọng:** dashboard → xác thực/quyền lớp → vé thử → API demo → kho thử → giao diện học viên → nhận bài và phản hồi; API/database lớp thật chỉ được đọc nguồn phiếu.
- **Tải:** giả định tối đa 20 giảng viên thử trong 60 giây, dựa trên ngưỡng lớp Progress Log hiện có. Chạy ca đồng thời bằng dữ liệu giả trước phát hành; không benchmark trên lớp thật.
- **Thời gian chờ:** tạo lượt trong vài giây; nếu nguồn hoặc demo chậm/lỗi, báo rõ và giữ dashboard/phiếu thật hoạt động.
- **Giới hạn:** vé mở thử hết hạn nhanh; lượt thử tự hết hạn sau 24 giờ, có giới hạn tốc độ và dọn dữ liệu hết hạn theo quy trình an toàn. Theo dõi kích thước kho riêng, không tích lũy vô hạn.
- **Lỗi/phục hồi:** không thể dùng vé sai lớp, hết hạn hoặc đã sửa; reset hai tab đồng thời chỉ một lượt thắng. Nếu dịch vụ demo lỗi, ngắt route demo và khôi phục Pages mà không động dữ liệu thật.
- **Theo dõi:** health của API demo, số lỗi mở thử, số lượt còn hiệu lực và kích thước kho; kiểm API thật, worker điểm danh và hàng chờ Portal trước/sau chuyển bản.

## Nghiệm thu và đường lui

Kiểm quyền đúng/sai lớp, vé giả/hết hạn, không lộ khóa chấm, nội dung và trạng thái phần đúng phiên bản, autosave/reload, feedback đúng/sai, nộp cuối, làm lại, song song, responsive, bộ nhớ học viên thật không bị ghi đè, và database/Portal thật không phát sinh side effect. Chạy full suite trên revision cuối, canary trên bản chạy và đọc lại đích. Giữ snapshot image API và Pages trước chuyển; rollback riêng từng phần, không xóa dữ liệu lớp thật.

## Đối chiếu bản chạy ngày 29/09

Sau bản sửa phiên đăng nhập, API `mapping-review-api` chạy image ID `sha256:86415d13eccebb0936edcd3911be2ed5471906b111a15f8a9003d9bfaf98aefb` và đã được đọc lại ở trạng thái `healthy`. Image này giữ phiên 90 ngày; bản overlay demo đã cập nhật hash `app.js` theo image mới và áp thành công lên bản sao source. Cả 9/9 ca demo trên bản sao, bài kiểm phiên 90 ngày và bộ test backend 236/236 đều đạt. Dockerfile overlay nay chạy lại bài kiểm phiên ngay trên image demo ứng viên để không tái phát lỗi 8 giờ. Các biến `LEARNING_ENABLED`, `LEARNING_DATABASE_URL`, `LEARNING_ATTENDANCE_SYNC_URL`, `ERP_SYNC_SECRET` đã được kiểm về sự hiện diện; `LEARNING_DEMO_SOURCE_SECRET` chưa được thêm. Trước phát hành phải kiểm lại image ID/hash live, thêm secret đúng nơi, backup rồi đối chiếu Portal và hàng chờ sau canary. **Tính năng xem thử vẫn chưa phát hành lên production.**
