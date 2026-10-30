# Progress Log — Thẻ 22–23

Trạng thái: code và migration đã kiểm trên dữ liệu giả, chưa áp production.

## Hợp đồng

- `POST /teacher/form-drafts/:id/edit` mở bản sửa hiện hành của cùng phiếu. Root worksheet được khóa trong transaction; bản đã xuất bản, form version và lần giao cũ bất biến.
- `POST /teacher/form-drafts/from-assignment/:id/edit` kiểm quyền lớp rồi tìm phiếu nguồn thuộc người sửa. Nguồn của người khác trả `WORKSHEET_SOURCE_NOT_OWNED`; giao diện có thể tạo bản riêng bằng luồng copy hiện hành.
- Danh sách nháp và Kho cá nhân trả head/worksheetId để giao diện không lộ các revision nội bộ thành bản sao. Hợp đồng list mặc định ở service vẫn tương thích caller cũ.
- Lần giao nhận `origin:{source,id}` tùy chọn, kiểm ID, chủ/quyền và content hash. `form_assignment_origin` lưu nguồn lần giao bất biến; giao diện mới luôn gửi nguồn đã chọn.
- `GET /teacher/options?includeOrigins=1` bổ sung nguồn cho phiếu đã giao. Bỏ query giữ payload/cách đọc tương thích.
- `approve(...,libraryOnly:true)` cho duyệt vào kho độc lập với lớp ngữ cảnh cũ; quyền chuyên môn của khóa vẫn bắt buộc. Khi giao, kiểm khóa của lớp vẫn áp dụng.
- `POST /teacher/writing-test-result` dùng xác thực/CSRF giảng viên hiện hành. API kiểm quyền lớp, studentRef và kết quả Test hiện hành trước khi đọc bài. Không tạo lượt, không cấp token học viên và không mở thao tác sửa/chấm.
- Tổng quan lớp có thể đọc đủ nguồn Test theo lô, giữ kết quả chưa gắn buổi để chi tiết khớp màn học viên; tránh đọc riêng từng học viên. Giới hạn 500 người và 100 Test.

## Migration và dữ liệu cũ

`202610300001_worksheet_revisions.sql` chỉ bổ sung ba bảng cùng index, quyền và trigger bất biến. Nguồn cũ được backfill bằng các quan hệ draft/publication/library đã lưu, không sửa nội dung hoặc hash của assignment.

Người dùng đã chốt xếp 17 phiếu cũ còn thiếu nguồn vào Kho cá nhân. Danh sách ID và câu SQL vận hành được giữ riêng trong gói phát hành; không đưa ID dữ liệu thật vào repository công khai. Chỉ áp đúng tập đã chốt và đọc lại, không tự phân loại mọi phiếu chưa biết nguồn về sau.

## Bằng chứng và giới hạn

- Regression mới thất bại trên base vì chưa có `editWorksheet`, đạt trên code mới.
- 16 test API/service: nội dung/key, kho, xuất bản/giao, nguồn, phiên bản logic, Test theo lô, quyền và Writing chỉ đọc.
- PostgreSQL nhiều kết nối, role `learning_api`: hai edit/save cạnh tranh, một head, xung đột đúng revision, migration lặp an toàn, publication/assignment cũ bất biến, không sinh submission/outbox.
- Chrome + API/PGlite cách ly kiểm hành trình soạn/xuất bản/giao hai lớp giả/sửa lại.
- Image ứng viên được ghép từ source live, giữ các overlay ngoài gói và cấu hình runtime; kiểm cookie 90 ngày, trần 365 ngày, CORS, restore/logout bằng fixture trong image.

Phát hành cần sao lưu schema/dữ liệu và cấu hình đang chạy, kiểm drift source/image, áp migration tương thích, chuyển API, rồi giao diện. Quay code về image cũ nếu lỗi; giữ bảng bổ sung và dữ liệu mới hợp lệ, không restore dump cũ lên bài học viên. Không có quyền giao/nộp/chấm thử cho lớp thật; outcome Portal sau triển khai giữ chưa xác minh tới khi có bằng chứng được phép.
