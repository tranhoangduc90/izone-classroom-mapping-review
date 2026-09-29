# Bản thử chung cho mọi Progress Log

Giảng viên chọn phiếu đã phát hành trong dashboard rồi bấm **Xem thử như học viên**. API thật kiểm quyền lớp và cấp vé gắn với phiếu/phiên bản, hết hạn sau 5 phút. Dịch vụ demo nhận vé, đọc nội dung và đáp án qua cổng máy chủ riêng, tạo một lớp và ba học viên mẫu trong kho PGlite độc lập. Bài làm và điểm danh chỉ tồn tại trong kho này. Trang học viên mẫu có nút **Mở các phần để thử** và **Làm lại từ đầu**; lượt cũ bị vô hiệu. Mỗi lượt tự hết hạn sau 24 giờ. Link học viên công khai không cấp quyền tạo bản thử.

## Biên giới dữ liệu

- API thật chỉ xuất nội dung phiếu và đáp án chấm máy cho dịch vụ demo có khóa `LEARNING_DEMO_SOURCE_SECRET`; không xuất roster, bài làm hoặc nhận xét. Chỉ giảng viên có quyền lớp được cấp vé xem thử.
- API thật từ chối header `x-progress-log-demo: 1`. API demo yêu cầu header đó và origin Pages được phép.
- API demo không kết nối database thật. Điểm danh được mô phỏng và không gọi Portal, n8n hay webhook.
- API demo có kho PGlite riêng, marker cố định và từ chối dùng một kho learning khác.
- Đường API riêng `/mapping-api-progress-log-demo/` tránh xung đột ứng dụng K56 đang dùng `/mapping-api-demo/`.

## Cấu hình phát hành

### Giữ nguyên image API đang chạy

Image API production hiện tại có thay đổi đăng nhập chưa nằm trong nhánh Git nền. Không dựng lại toàn bộ API từ nhánh này để thay image đang chạy. File [live-api-overlay.patch](live-api-overlay.patch) chỉ thêm năm file API liên quan bản thử trên snapshot source đã đọc từ image live; [live-api-baseline-sha256.json](live-api-baseline-sha256.json) khóa hash bốn file gốc. Chạy [prepare-live-overlay.py](prepare-live-overlay.py) với thư mục source vừa đọc từ image và một thư mục đầu ra trống: script so hash, áp patch, kiểm cú pháp rồi tạo build context; nếu source thay đổi, nó báo `LIVE_SOURCE_CHANGED` và dừng. Bản vá đã được áp vào bản sao image source và 9/9 ca test demo đạt. Trước phát hành, đọc lại hash image/container và source; nếu khác bất kỳ hash nào thì dựng/kiểm lại patch. [Dockerfile.live-api-overlay](Dockerfile.live-api-overlay) nhận `LIVE_API_IMAGE` là image ID/digest đã kiểm và năm file trong build context, tạo image mới giữ nguyên phần đăng nhập/điểm danh của image cũ; build lỗi thì không thay container. Giữ nguyên cấu hình điểm danh, quyền, image cũ và rollback trước khi thay container. Không chạy migration trên database lớp thật cho tính năng này.

1. Sau khi duyệt phát hành, tạo khóa ngẫu nhiên ít nhất 32 ký tự ở nơi giữ bí mật. Đặt cùng giá trị vào `LEARNING_DEMO_SOURCE_SECRET` của API thật và `DEMO_SOURCE_SECRET` trong `/opt/progress-log-demo/.env`. Không ghi giá trị vào Git, log hoặc tài liệu.
2. Dựng image API thật từ bản vá có hash guard ở trên, backup cấu hình/image hiện hành, bổ sung biến môi trường rồi thay container theo runbook của bản phát hành. Đọc lại `/mapping-api/health` và kiểm các API Progress Log cũ.
3. Dựng dịch vụ riêng bằng [compose.yml](compose.yml). File [.env.example](.env.example) ghi tên biến cần có. Volume `progress-log-demo-data` chỉ chứa dữ liệu mẫu. Đọc lại `/health` tại cổng nội bộ `8797`.
4. Thêm [nginx-location.conf.example](nginx-location.conf.example) vào server HTTPS, chạy `nginx -t`, reload và đọc lại `https://ducizone.ddns.net/mapping-api-progress-log-demo/health`.
5. Chỉ sau các bước trên, phát hành Pages. Kiểm một phiếu đã phát hành có phần khóa, mở phần trong demo, lưu nháp, bài nộp, phản hồi và nút làm lại bằng dữ liệu mẫu; xác nhận không có dòng nào được ghi vào database lớp thật. Kiểm nút xem thử không hiện phiếu demo cũ trong danh sách, nhưng link cũ vẫn mở được.

## Rollback và vận hành

- Nếu dịch vụ demo lỗi, gỡ route Nginx riêng và trả Pages về revision trước. API thật có thể giữ cổng nguồn nhưng nên bỏ khóa khi không dùng. Không đụng `/mapping-api-demo` của K56.
- Nếu API thật lỗi, trả image và cấu hình đã backup; không chạy migration database vì thay đổi này không cần migration production.
- Lượt thử hết hạn sau 24 giờ nhưng PGlite giữ dữ liệu cũ cho đến đợt dọn kho. Theo dõi kích thước volume. Khi cần làm sạch: dừng riêng container demo, xác nhận volume đúng tên và marker demo, backup nếu cần điều tra, rồi tạo lại volume riêng theo quy trình vận hành. Không xóa khi còn lượt đang dùng.
- Link xem thử chứa vé 5 phút trong fragment URL. Không chia sẻ hoặc chụp fragment; sau khi mở, trang thay vé bằng mã lượt thử riêng.

## Kiểm thử cục bộ

Chạy `node scripts/preview-learning-demo.mjs` trong thư mục `backend`, rồi mở link `#grant=` mà script in ra trên Pages `localhost:5173`. Máy chủ preview chỉ chứa dữ liệu giả, không gọi production.
