# Phát hành Progress Log IC2305 · Buổi 4

## Kết quả cần thấy

- Học viên mở phiếu mới “Buổi 4 - Listening 1 + Speaking 2” gồm hai phần. Giảng viên điều khiển thời điểm mở từng phần.
- Trong màn xem bài của từng học viên, giảng viên viết và gửi nhận xét Speaking. Học viên thấy lời nhận xét trên trang tổng hợp cá nhân, kể cả khi chưa có báo cáo định kỳ.
- Phiếu “ENTRANCE TICKET • READING 1 & LISTENING 1” chuyển sang trạng thái lưu trữ; bản ghi và mọi bài nộp cũ được giữ nguyên. Giao dịch tạo phiếu mới và lưu trữ phiếu cũ phải thành công cùng nhau.

## Thứ tự phát hành

1. Đối chiếu image production với các hash trong Dockerfile và kiểm lại lớp IC2305, Buổi 4, ID phiếu cũ, trạng thái và số bài nộp bằng truy vấn chỉ đọc.
2. Sao lưu database PostgreSQL và kiểm danh mục backup; giữ nguyên container cũ để có thể quay lại mà không in biến môi trường có secret.
3. Áp migration `202609240001_teacher_session_speaking_feedback.sql`. Đọc lại bảng, quyền `learning_api` và không có bản ghi nhận xét phát sinh ngoài dự kiến.
4. Dựng image ứng viên từ image production hiện tại. Dockerfile kiểm hash trước khi thay bốn module hiện có và thêm template, helper thay phiếu, publisher.
5. Chuyển API sang image ứng viên, kiểm health, quyền giảng viên và endpoint đọc dữ liệu. Nếu lỗi, khởi động lại container/image cũ; migration chỉ thêm bảng và quyền nên tương thích với bản cũ.
6. Phát hành Pages từ đúng commit đã kiểm. Đọc lại asset revision, giao diện điện thoại và console/network trên URL thật.
7. Chạy publisher với mẫu `session4-listening1-speaking2`, lớp `IC2305`, buổi `4`, ID phiếu cũ `0607693f-8af9-4c1c-9f3e-09f894761381` và hai tài khoản có quyền tạo/duyệt. Publisher tự khóa, kiểm định danh, commit cùng một transaction và readback.
8. Đọc lại hai assignment: phiếu mới `published`, phiếu cũ `retired`, roster mới đủ và số submission cũ không đổi. Kiểm link phiếu cũ không mở được, link phiếu mới hiển thị đúng nội dung; tuyệt đối không tạo bài giả dưới tên học viên thật.

## Điểm chặn và hoàn tác

- Dừng nếu image gốc, quyền tài khoản, roster, tiêu đề/ID phiên bản phiếu cũ hoặc số bài nộp khác bản đọc trước. Không tự chọn một assignment khác để thay.
- Nếu API lỗi trước khi phát hành phiếu, quay lại image cũ. Không xóa migration hay bảng dữ liệu.
- Nếu phiếu đã phát hành và có học viên bắt đầu làm, giữ dữ liệu và sửa tiếp theo hướng forward-fix; không xóa assignment hay câu trả lời.
- Nhận xét Speaking là dữ liệu riêng tư. Chỉ dùng tài khoản giảng viên có quyền; link tổng hợp cá nhân phải gửi đúng học viên và việc tạo link mới sẽ vô hiệu link cũ.
