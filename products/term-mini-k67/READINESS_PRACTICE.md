# Reading và Writing làm quen K67

Đây là phần tiếp nối bài kiểm âm thanh riêng. Không sửa phòng chờ bài thi thật, không mở đề thật, không chấm điểm hoặc gọi dịch vụ chấm/đồng bộ.

## Hành trình

Sau khi nộp Listening thử, học viên có thể chọn Reading hoặc Writing trên cùng dòng tiêu đề. Hai phần là tùy chọn; phần chưa làm hiển thị **Chưa thử**, không coi là trượt hoặc điểm 0.

- Reading: đoạn văn tự soạn về khu vườn thư viện, ba câu hỏi. Bố cục đoạn đọc và câu trả lời đặt cạnh nhau trên máy tính.
- Writing: đề tự soạn về nơi thư giãn, gợi ý 2–3 câu, có số từ và giới hạn 12.000 ký tự.
- Thời lượng hiển thị chỉ là gợi ý; không tự thu bài.
- Nháp lưu tự động hoặc bằng nút Lưu nháp. Chỉ hiện đã lưu khi API trả lại đúng nội dung/revision.
- Mất mạng giữ nháp tại trình duyệt; có mạng thì đồng bộ lại. Khi reload vẫn phải xác thực phiên trước. Không bổ sung service worker để mở trang hoàn toàn offline.
- Nộp yêu cầu bản cuối đã được đọc lại. Nếu mất phản hồi nộp, đọc lại phiên để phân biệt đã nộp với chưa nộp.
- Xem lại và reload bài đã nộp đều khóa sửa. Đổi người học hoặc làm lại không mang nháp sang lượt mới.

## Dữ liệu và API

Áp dụng migration 013 rồi **014-readiness-reading-writing.sql** trong môi trường thử trước khi bật phiên bản này. Không áp dụng migration lên production trong task này.

Migration 014 chỉ thêm sáu cột vào bảng `assessment.k67_readiness_session`: dữ liệu nháp, số phiên bản nháp và thời điểm nộp riêng cho mỗi kỹ năng. Listening giữ nguyên các cột và ý nghĩa hiện có. Phiên Listening đã nộp trước khi nâng cấp có thể làm tiếp hai phần mới.

`POST /api/k67-readiness/v1/practice/{reading|writing}/draft` nhận token thử, revision và data. Reading chỉ nhận khóa 1–3; Writing chỉ nhận text. Bản cũ không ghi đè bản mới; cùng revision khác nội dung bị từ chối.

`POST /api/k67-readiness/v1/practice/{reading|writing}/submit` nhận token thử và revision đã lưu. Nộp lặp giữ nguyên thời điểm và nội dung lần đầu. Hai kỹ năng không thay đổi bài Listening đã nộp hoặc dữ liệu bài thi thật.

`POST /session` và các phản hồi ghi trả thêm `practice.reading` / `practice.writing`, gồm data, revision, submittedAt. Token vẫn bị kiểm hết hạn, lớp cho phép và membership mỗi lần; không có đường cấp nội dung/khóa đề thật từ API này.

## Kiểm và quay lui

Chạy `node --test test/readiness.test.js test/readiness-practice.test.js`. Bộ fixture áp dụng cả hai migration trên DB giả; có thể dùng PostgreSQL native theo biến môi trường đã mô tả ở helper. Kiểm trình duyệt cần bao gồm mất mạng, reload nháp, mất ACK lưu/nộp, tab trùng, xem lại sau nộp và tiêu đề một dòng ở màn hình rộng/hẹp.

Nếu cần quay lui khi được phép phát hành: đưa frontend về bản chỉ có Listening trước, sau đó backend về bản trước. Giữ các cột 014 và dữ liệu đã ghi; không chạy DROP hoặc xóa nháp để quay lui. Bật/tắt `K67_READINESS_ENABLED` tác động toàn bộ bài làm quen, không phải công tắc riêng Reading/Writing; chỉ tắt khi đã xử lý các phiên đang hoạt động. Phòng chờ bài thi thật không thuộc gói này.
