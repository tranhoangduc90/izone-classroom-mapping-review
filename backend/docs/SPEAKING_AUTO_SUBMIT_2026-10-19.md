# Tự nộp Speaking — 19/10/2026

Trang học viên Lesson 2–9 tự gửi yêu cầu nộp khi mọi phần hiện hành đã được công nhận. API tiếp tục kiểm quyền, trạng thái nguồn, bài bắt buộc và hội thoại riêng trong transaction; trình duyệt không tự công nhận bài.

## Phần thay đổi

`speaking-independent.js` bỏ yêu cầu `manualSubmit=true` riêng cho link có `evidence.recoveryId`. Các bài đã được công nhận lại cũng dùng cùng đường nộp tự động; không sửa lại trạng thái công nhận hoặc bắt học viên xác nhận lại.

Nguồn module được đối chiếu exact live trước sửa. Những phần đang chạy nhưng chưa có trong main — công nhận theo lời chatbot, lease bốn phút và evidence trong màn giảng viên — được giữ cùng dependency `speaking-completion-policy.js`. Dependency khớp nội dung live sau chuẩn hóa xuống dòng; không đổi prompt hoặc gọi AI khi kiểm tự nộp.

Runtime phát hành chỉ thay `src/speaking-independent.js` trên nền live riêng của Speaking. Không rebuild toàn backend từ main, không sửa API chung, registry n8n hoặc migration. Trường `manualSubmit` tùy chọn cũ vẫn tương thích; client mới không gửi giả thao tác thủ công.

## Kiểm

`test/speaking-independent.test.js` bổ sung evidence công nhận lại vào luồng năm link và đọc lại receipt sau retry. Ca PostgreSQL nhiều connection gửi 12 HTTP request `/finish` cùng phiên; cần một receipt, một job phân tích và một job ghi Docs giả. Đích Docs trong fixture luôn có đủ document_id/tab_id theo ràng buộc database, không chạy writer thật.

Bộ Speaking backend gồm 122 ca native đã chạy trong kho bằng chứng riêng. Lượt đầu 121 đạt và một fixture thiếu tab_id lỗi trước khi gửi HTTP; đã sửa fixture, chỉ chạy lại ca còn thiếu và đạt. Không đếm lần lỗi là pass hoặc cộng trùng ca chạy lại. Không kết luận Docs thật/AI thật thành công từ fixture.

## Phát hành và quay lại

Chuẩn bị image từ đúng image đang chạy, chép đúng một module; đối chiếu hash của 74 file source. Kiểm bản sao container chưa chạy, giữ Env/mount/network/IP, giữ container cũ để quay lại. Việc nguồn main có thay đổi mới không tự cho phép rebuild toàn runtime.

Biên nhận, bài nộp và hàng xử lý mới không bị xóa khi rollback. Đường lui và journal riêng nằm trong gói `speaking-auto-submit-20261019` của người vận hành; không lưu Env hoặc dữ liệu học viên vào Git.
