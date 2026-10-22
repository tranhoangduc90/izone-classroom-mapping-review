# Progress Log — giao diện Thủy, đợt IC2305

Gói này nối giao diện mới với dữ liệu thật. Không tự đổi nội dung, hạn hoặc trạng thái mở phần của phiếu đã phát. Phiếu buổi 11 vẫn là phiên bản đã chốt từ nguồn Google Docs.

## Hành vi được bổ sung

- Gia hạn toàn phiếu bằng thời điểm kết thúc và lý do; kiểm quyền lớp, revision và mã thao tác. Giữ mốc tự khóa ban đầu, bài đã nộp và lịch sử thay đổi.
- Thu hồi ngừng nhận bài, giữ bài làm/nháp/điểm danh. Chỉ giảng viên đọc lịch sử; có thể giao phiếu mới cho đúng buổi.
- Kho cá nhân giữ bản chụp. Kho IZONE chỉ nhận bản đã duyệt từ người có quyền chuyên môn hoặc quản trị; dùng lại tạo nháp riêng. Chưa có bộ bài chuẩn do người phụ trách cung cấp, không tự gắn phiếu đã dùng thành bài chuẩn.
- AI nhận văn bản có sẵn, đối chiếu trích đoạn và mã yêu cầu. Không suy đáp án; phần chưa chuyển vẫn hiện để kiểm. Chỉ sau giảng viên xác nhận mới lưu vào nháp.
- Bộ soạn nhận chọn nhiều, nối cặp, điền từ có nhiều cách viết và gợi ý câu mở. Key/lời giải nằm trong phần riêng; chỉ phát cho học viên theo quyền mở đáp án.
- Mini Test IC2305 đọc từ meta đăng ký lớp ERP, nối qua mã contact của order item. Listening /10, Reading /13; thiếu khác 0. Không suy ngày thi, band hoặc nhận xét Writing. Lưu bản đọc có hash/thời điểm và báo rõ khi ERP tạm lỗi.

## Thứ tự vận hành

1. Chụp cấu hình và sao lưu database riêng tư. So module live với nền Git; không xây lại toàn API từ một checkout có thể cũ hơn các sản phẩm khác.
2. Áp dụng ba migration `202610220001`–`202610220003` bằng chủ database; cấp quyền hạn chế cho `learning_api` ngay trong migration.
3. Thay đúng module Learning trên image live đã đối chiếu. Giữ toàn bộ cấu hình, thư mục gắn, mạng, phiên đăng nhập và luồng điểm danh. API demo phải có image nền riêng.
4. Đọc lại dữ liệu, cấu hình, source hash, hàng chờ và giao diện Pages. Không dùng bài thử ghi vào lớp thật để chứng minh giao diện.

Quay lại bằng container/image đã giữ; giữ schema bổ sung và dữ liệu mới, không xóa bảng hoặc phục hồi đè database chỉ để quay lại giao diện. Cờ `THUY_PILOT_CLASS_IDS` ở Pages giới hạn chuyển lối vào cho IC2305. Đường cũ hỗ trợ `presentation=legacy` để xử lý sự cố.

## Phần cần quan sát khi dùng thật

Một buổi IC2305 trọn, điện thoại thực tế với bàn phím/mất mạng, và một lần ghi rồi đọc lại Portal mới vẫn cần bằng chứng vận hành. Health, bài thử hoặc job lịch sử không thay các bằng chứng này. Nháp nhận xét chưa công bố vẫn ở trình duyệt giảng viên theo lựa chọn đã chốt.
