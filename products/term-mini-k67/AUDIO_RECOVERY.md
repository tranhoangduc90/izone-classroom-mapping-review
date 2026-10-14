# Ghi tiến độ và khôi phục audio K67

Bản ứng viên ngày 14/10/2026; chưa phát hành production.

Áp dụng Term 1, Term 2, Mini Buổi 5 CBT, cả Listening trước và Reading trước. Trang lưu mốc khoảng mỗi 5 giây. Khi audio ngắt hoặc vào lại, API dùng mốc được xác nhận để khôi phục và trả hạn mới; việc lưu lỗi không ngăn audio phát.

## Quy tắc

- Khóa hàng phiên trong giao dịch; bài đã nộp, lượt bị thay thế, sai bài/generation và Listening chưa được mở không được cập nhật.
- Mốc không lùi, không vượt thời gian nghe hợp lệ hoặc độ dài audio. Máy chủ tính gián đoạn bằng giờ của mình, trần cộng dồn 900 giây; không bù trong phần rà bài sau audio.
- Mỗi sự kiện khôi phục có UUID. Retry phải giữ nguyên mã và nội dung; mã đã ghi không được cộng giờ lần hai. Bảng mới chỉ ghi sự kiện, không sửa bài cũ.
- Lượt cũ không có checkpoint không được cộng giờ hồi tố từ đầu bài. Lượt đã nộp không được mở lại.
- Cảnh báo rời/tải lại trang dùng hộp thoại chuẩn của trình duyệt; chỉ bật khi đang làm bài và trình duyệt đã nhận thao tác của người dùng. Chuyển kỹ năng sau nộp thành công được miễn cảnh báo. Trình duyệt quyết định câu chữ; đóng cưỡng bức ứng dụng có thể không phát sự kiện.

## Kiểm

`test/audio-progress.test.js` kiểm HTTP và đọc lại PostgreSQL: sáu bài/thứ tự, lost ACK, đồng thời/replay, dữ liệu sai, giới hạn, bài đã nộp và 11 lượt độc lập. Các bài kiểm trình duyệt thuộc repository Pages: `k67-audio-checkpoint-browser.mjs` và `k67-audio-leave-acceptance.mjs`. Dùng fixture localhost và dữ liệu giả; không trỏ bộ kiểm vào dữ liệu học viên thật.

Bằng chứng ứng viên được giữ riêng ngoài Git: backend 212 ca, công cụ Python 79 ca; Pages 135 ca qua hợp các lượt trên cùng source sản phẩm và fixture, không skip. Chrome và Edge đạt chín tình huống cảnh báo/khôi phục. Test gốc thất bại trên source nền rồi đạt trên source ứng viên. Đây là kiểm source và runtime Node/PostgreSQL; chưa dựng image hay quan sát ứng viên trên production.

## Thứ tự phát hành khi được duyệt

1. Đọc lại live/base và phiên đang thi; giữ cấu hình, quyền, kho audio/ngữ cảnh/chấm hiện hành. Nếu nguồn live đổi, đối chiếu trước khi chuyển.
2. Backup riêng K67. Áp dụng migration `db/009-audio-recovery-events.sql` bằng chủ schema, sau đó chuyển API K67. Không dùng API/database của sản phẩm khác.
3. Chuyển Pages với phiên bản asset mới. Tab cũ vẫn tiếp tục được; không reset lượt để ép tải bản mới.
4. Dùng lượt giả được phép để kiểm request, checkpoint đọc lại, ngắt/phát tiếp, deadline chỉ cộng một lần, nộp và chặn sửa sau nộp. Kiểm log và consumer của K67. Thiếu kết quả này thì trạng thái là đã triển khai, còn chờ xác minh.

Quay lui code/image và asset riêng. Giữ bảng sự kiện, bài đã nộp và hạn đã được xác nhận; không restore dump cũ hoặc rút ngắn hạn của lượt đang thi. Không cần xóa bảng mới để chạy lại image cũ.
