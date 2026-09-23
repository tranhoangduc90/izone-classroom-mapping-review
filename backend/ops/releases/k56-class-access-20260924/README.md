# Quyền mở bài thi theo lớp và đề khóa 56

Trạng thái: **chỉ có trên branch thử, chưa chạy migration hoặc phát hành production**.

## Người dùng sẽ thấy gì

IC2264 vẫn mở đúng ba đề K56 hiện tại. Một lớp K56 mới dù đã có mapping vẫn chưa hiện roster và chưa nhận lượt thi/đăng ký Mini cho tới khi được cấp quyền riêng cho đúng đề. K67 không đổi.

## Điều kiện trước khi phát hành

1. Chụp backup/snapshot database và image hiện hành; xác nhận không có migration cùng tên đã chạy.
2. Đọc lại mapping IC2264 (`erp_course_class_id = 1252`) và ba định nghĩa đề K56 active. Nếu thiếu hoặc khác số liệu đã kiểm, dừng.
3. Chạy migration `202609240001_term_test_k56_class_access.sql` **trước** image backend mới; migration không sửa bài nộp, roster hoặc điểm.
4. Dùng quyền API đọc lại đúng ba hàng IC2264 `enabled = true`, không có hàng lớp khác. Nếu không đúng, không đổi image.
5. Chỉ sau khi regression, staging và quality gate chung đạt `ready` mới xin duyệt phát hành backend; tài liệu này không cấp quyền deploy.

## Cấp quyền cho lớp mới sau khi đã xác minh lịch thi

Không suy ra quyền thi từ trạng thái `on_going`, mapping hay roster ERP. Người vận hành xác nhận lớp, mã đề, thời điểm mở, roster và cột Portal trước; sau đó ghi một cặp `(test_slug, erp_course_class_id)` với `enabled = true` trong `assessment.term_test_class_access` bằng giao dịch được phê duyệt. Đọc lại đúng hàng vừa ghi và thử trang học viên bằng tài khoản kiểm thử; không mở hàng loạt 271 lớp lịch sử.

## Hoàn tác an toàn

Nếu một lớp mới bị mở sai, tắt đúng hàng quyền của lớp–đề đó; không xóa bài hoặc điểm đã tồn tại. Nếu bản backend mới có lỗi, quay image về bản cũ **chỉ sau khi đã dừng mở các lớp mới**: bản cũ không đọc bảng quyền, nên rollback image đơn lẻ có thể mở lại lớp qua mapping. Đối chiếu bài đang làm và kết quả trước khi chuyển; giữ migration additive để rollback ứng dụng không mất dữ liệu.

## Bằng chứng trên branch

Test database tái hiện lỗi cũ (RED `class_count = 1` cho lớp chưa duyệt), sau sửa GREEN; kiểm cả roster, xác minh học viên, Mini tạm, quyền từng đề, K67 và migration chạy lại. Cần kiểm thêm staging/live readback trước phát hành.
