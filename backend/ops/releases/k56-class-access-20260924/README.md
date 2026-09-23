# Quyền mở bài thi theo lớp và đề khóa 56

Trạng thái: **chỉ có trên branch thử, chưa chạy migration hoặc phát hành production**.

## Người dùng sẽ thấy gì

IC2264 vẫn mở đúng ba đề K56 hiện tại. Theo phạm vi Đức đã chốt, mọi lớp khóa 56 có trạng thái `on_going` trong ERP được mở ba đề Term 1, Term 2 và Mini sau khi đã nhập roster đúng lớp và xác nhận cột Portal. Lớp ngoài phạm vi hoặc thiếu roster vẫn bị đóng. K67 không đổi.

## Điều kiện trước khi phát hành

1. Chụp backup/snapshot database và image hiện hành; xác nhận không có migration cùng tên đã chạy.
2. Đọc lại mapping IC2264 (`erp_course_class_id = 1252`), ba định nghĩa đề K56 active và danh sách ERP `on_going` tại thời điểm triển khai. Audit chỉ đọc ngày 24/09 thấy 29 lớp/447 đăng ký active; backend chỉ có mapping và roster của IC2264, bảng quyền chưa tồn tại. Nếu snapshot mới khác hoặc có mã lớp–ID mâu thuẫn, dừng để đối soát.
3. Chạy migration `202609240001_term_test_k56_class_access.sql` **trước** image backend mới; migration không sửa bài nộp, roster hoặc điểm.
4. Dùng quyền API đọc lại đúng ba hàng IC2264 `enabled = true`, không có hàng lớp khác. Nếu không đúng, không đổi image.
5. Chỉ sau khi regression, staging và quality gate chung đạt `ready` mới xin duyệt phát hành backend có cổng quyền; tài liệu này không cấp quyền deploy. Chưa nhập mapping/roster lớp mới trước khi image có cổng quyền chạy và đã thử fail-closed trên lớp chưa mở.

## Mở các lớp K56 đang học

Nguồn quyết định phạm vi là ERP khóa 56, lớp chưa xóa và `status = on_going`; Đức đã xác nhận không cần chờ lịch thi riêng. Mỗi lần đồng bộ phải chụp tập ID/mã lớp, lấy đăng ký mới nhất theo cặp lớp–contact và chỉ nhận trạng thái học viên `on_going`, xác nhận đủ cột Portal của hai Term, đối chiếu mapping/roster hiện có và giữ `student_ref` của bài đã nộp. Không đưa tên hay ID học viên vào Git/report. Sau khi backend có cổng quyền, nhập mapping/roster theo giao dịch và đọc lại số lớp/số học viên; cuối cùng mới bật đúng ba cặp `(test_slug, erp_course_class_id)` cho từng lớp qua giao dịch được phê duyệt. Không bật lớp không còn `on_going` ở thời điểm ghi; không mở 271 lớp lịch sử.

## Hoàn tác an toàn

Nếu một lớp mới bị mở sai, tắt đúng hàng quyền của lớp–đề đó; không xóa bài hoặc điểm đã tồn tại. **Không rollback riêng image về bản cũ không có cổng quyền khi mapping/roster mới còn trong database**: image cũ có thể mở lại lớp dù hàng quyền đã tắt. Trước phương án rollback image phải chứng minh một tuyến thay thế vẫn chặn lớp chưa duyệt, hoặc cô lập endpoint và xử lý các mapping mới theo backup/giao dịch đã kiểm, có phê duyệt riêng. Đối chiếu bài đang làm và kết quả trước khi chuyển; giữ migration additive để không mất dữ liệu.

## Bằng chứng trên branch

Test database tái hiện lỗi cũ (RED `class_count = 1` cho lớp chưa duyệt), sau sửa GREEN; kiểm cả roster, xác minh học viên, Mini tạm, quyền từng đề, K67 và migration chạy lại. Cần kiểm thêm staging/live readback trước phát hành.
