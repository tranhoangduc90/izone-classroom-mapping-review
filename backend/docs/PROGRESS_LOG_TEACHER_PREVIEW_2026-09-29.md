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


Đã phát hành API `sha256:1876b7b6c03add8ced91c2f117a278a1343829f9a3f69a6b27f4784a572091de`, dịch vụ demo `sha256:c4a2f67ba94534c05ad0b2e6485626474f20724636e9b1826e74876673e615c1` và Pages commit `85296ea`. Chrome của giảng viên mở được phiếu IC2304 buổi 3, nộp đủ ba phần, hiện Reading 1/2 với câu đúng/sai và làm lại thành lượt sạch.

Dịch vụ demo cần giới hạn RAM 1 GiB: mức 384 MiB ban đầu làm PGlite hết bộ nhớ khi khởi tạo. Sau điều chỉnh, cả API thật và dịch vụ demo đều khỏe, không có lượt restart. Đích đồng bộ điểm danh giữ cùng SHA-256 `03e9ff1c3a668ff8168346fa98063b5552191c48d410ec19d6ec9af0c7ff8cb8`; hàng chờ Portal vẫn có 102 việc hoàn tất. Chưa có sự kiện điểm danh thật mới sau phát hành để đối chiếu Portal; trạng thái kiểm chứng phần này còn chờ.