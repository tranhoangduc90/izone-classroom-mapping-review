# Quyền mở bài thi theo lớp và đề khóa 56

Trạng thái: **chỉ có trên branch thử, chưa chạy migration hoặc phát hành production**.

Kiểm topology chỉ đọc ngày 24/09: API mapping chung dùng database `mapping_db` qua `mapping-postgres` trên mạng `mapping-api-net`; API K56 dùng database `izone_mapping_k56_ic2264` qua `k56-demo-db` trên mạng `izone-k56-demo_default`. Không có kết nối trực tiếp giữa hai API. Để giữ cô lập, bước nhập roster nên là snapshot một chiều có điều kiện, không đổi `DATABASE_URL` của backend K56 sang database chung và không mở thêm mạng Docker chỉ để đọc roster.

## Người dùng sẽ thấy gì

IC2264 vẫn mở đúng ba đề K56 hiện tại. Theo phạm vi Đức đã chốt, mọi lớp khóa 56 có trạng thái `on_going` trong ERP được mở ba đề Term 1, Term 2 và Mini sau khi đã nhập roster đúng lớp và xác nhận cột Portal. Lớp ngoài phạm vi hoặc thiếu roster vẫn bị đóng. K67 không đổi.

## Điều kiện trước khi phát hành

1. Chụp backup/snapshot database và image hiện hành; xác nhận đúng database K56 riêng `izone_mapping_k56_ic2264` và không có migration cùng tên đã chạy. Nếu lỡ trỏ sang database API chính, dừng trước mọi câu ghi.
2. Đọc lại mapping IC2264 (`erp_course_class_id = 1252`), ba định nghĩa đề K56 active và snapshot K56 từ `mapping_db` dùng chung. Workflow nguồn đã chạy thật: production execution `2332131` và lượt đọc độc lập `2332138` đều thấy 29 lớp/447 đăng ký `on_going`; backend K56 vẫn dùng database riêng và chỉ có mapping/roster IC2264. Nếu snapshot mới khác hoặc có mã lớp–ID mâu thuẫn, dừng để đối soát.
3. Chạy migration `202609240001_term_test_k56_class_access.sql` **trước** image backend mới; migration không sửa bài nộp, roster hoặc điểm.
4. Dùng quyền API đọc lại đúng ba hàng IC2264 `enabled = true`, không có hàng lớp khác. Nếu không đúng, không đổi image.
5. Chỉ sau khi regression, staging và quality gate chung đạt `ready` mới xin duyệt phát hành backend có cổng quyền; tài liệu này không cấp quyền deploy. Chưa nhập mapping/roster lớp mới trước khi image có cổng quyền chạy và đã thử fail-closed trên lớp chưa mở.

## Mở các lớp K56 đang học

Nguồn quyết định phạm vi là ERP khóa 56, lớp chưa xóa và `status = on_going`; Đức đã xác nhận không cần chờ lịch thi riêng. Workflow `QOeOZVK1gsJ9Wo5r` đã đưa snapshot này vào `mapping_db` dùng chung, không phụ thuộc view Lark. Bước backend kế tiếp phải **đọc snapshot đã đối soát từ database mapping dùng chung**, không nhập tay danh sách mã lớp hoặc đọc lại ERP bằng một logic khác. K56 vẫn giữ database bài thi riêng để không ảnh hưởng K67 và các sản phẩm khác; cần tuyến đồng bộ một chiều có kiểm soát sang các bảng mapping/roster tại đây, với bằng chứng 29 lớp/447 đăng ký, khóa `(class_id, contact_id)` và không làm đổi `student_ref` của bài đã nộp. Chỉ nhận trạng thái học viên `on_going`, xác nhận đủ cột Portal của hai Term trước khi mở bài. Hai lớp IC2322/IC2326 chưa ghép Classroom vì roster rỗng vẫn có snapshot ERP; không tự coi đó là lý do loại khỏi nguồn K56, cũng không tự duyệt Classroom. Sau khi backend có cổng quyền, nhập mapping/roster theo giao dịch và đọc lại số lớp/số học viên; cuối cùng mới bật đúng ba cặp `(test_slug, erp_course_class_id)` cho từng lớp qua giao dịch được phê duyệt. Không bật lớp không còn `on_going` ở thời điểm ghi; không mở 271 lớp lịch sử. Không đưa tên hay ID học viên vào Git/report.

Định danh xuyên tuyến: mỗi học viên có khóa nguồn `(erp_course_class_id, erp_student_contact_id)`, mỗi hàng roster đích thêm `test_slug`; `sync_run_id` là mã lượt đọc, còn khóa chống ghi lặp là `(test_slug, class_id, contact_id)`. Không ghép theo tên hoặc thứ tự dòng. Trước khi ghi, dừng nếu lớp trùng mã nhưng khác ID, học viên sai lớp, nguồn rỗng, số lượng giảm bất thường hoặc thiếu đúng một trong ba đề. Sau khi ghi, đọc lại từng lớp/đề, xác nhận UUID `student_ref` cũ không đổi và mọi hàng mới đúng ID; không tự bật quyền khi phép đối soát chỉ đạt một phần.

Kiểm thử tối thiểu cho tuyến chuyển dữ liệu: một lớp/một học viên; lớp 0 học viên; nhiều lớp xen kẽ và thứ tự đảo; học viên trùng hoặc đổi trạng thái; chạy lại cùng `sync_run_id`; một lớp lỗi giữa lô; lớp cùng tên nhưng ID khác; và đối soát record đích không thuộc phạm vi vẫn nguyên vẹn. Bộ test backend hiện tại đạt 178/178 trên branch này, nhưng chưa bao gồm tuyến chuyển snapshot; không dùng 178 test đó làm bằng chứng tuyến mới đã sẵn sàng.

## Hoàn tác an toàn

Nếu một lớp mới bị mở sai, tắt đúng hàng quyền của lớp–đề đó; không xóa bài hoặc điểm đã tồn tại. **Không rollback riêng image về bản cũ không có cổng quyền khi mapping/roster mới còn trong database**: image cũ có thể mở lại lớp dù hàng quyền đã tắt. Trước phương án rollback image phải chứng minh một tuyến thay thế vẫn chặn lớp chưa duyệt, hoặc cô lập endpoint và xử lý các mapping mới theo backup/giao dịch đã kiểm, có phê duyệt riêng. Đối chiếu bài đang làm và kết quả trước khi chuyển; giữ migration additive để không mất dữ liệu.

## Bằng chứng trên branch

Test database tái hiện lỗi cũ (RED `class_count = 1` cho lớp chưa duyệt), sau sửa GREEN; kiểm cả roster, xác minh học viên, Mini tạm, quyền từng đề, K67 và migration chạy lại. Cần kiểm thêm staging/live readback trước phát hành.
