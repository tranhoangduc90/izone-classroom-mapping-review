# Mở Speaking Homework theo học viên đã chọn, giữ đích ghi là bản Docs từ CTA

## Hành vi

Học viên mở CTA trong một bản Homework Lesson 3 IC2304 và chọn tên mình trong danh sách lớp. API kiểm bản Docs thuộc đúng bài/lớp và tên được chọn là hồ sơ đã duyệt của lớp; API không còn yêu cầu tên được chọn phải trùng chủ bản Docs. Phiên vẫn giữ `documentId` của CTA. Khi đủ bốn link hợp lệ, việc ghi kết quả dùng `documentId` này. Học viên chọn nhầm tên có thể khiến biên nhận gắn với hồ sơ được chọn trong khi dòng xác nhận nằm ở bản Docs đã mở; giao diện cần giúp kiểm tên trước khi xác nhận.

## Phạm vi phát hành 29/09/2026

Image nền `izone-term-test-backend:20260928.speaking-cta-white-v1` được khóa bằng SHA-256 của module Speaking, worker điểm danh và server. Image mới `izone-term-test-backend:20260929.speaking-cross-doc-v1` chỉ chép lại `src/speaking-homework.js`; giữ nguyên module và cấu hình API khác. Container cũ còn ở tên `mapping-review-api-before-speaking-cross-doc-20260929` để quay lại có kiểm soát.

## Bằng chứng

- Test API hiện hành: 214/214 đạt; test đổi học viên trong cùng lớp đỏ trên revision gốc và xanh trên revision sửa. `npm run check` đạt.
- Test transaction trên database production bằng image mới: học viên khác chủ Docs cùng lớp mở phiên và grant giữ đúng `documentId`; transaction rollback, không để lại dữ liệu thử.
- Sau chuyển: container `mapping-review-api` khỏe, hash module Speaking đúng image mới; hash worker điểm danh và server không đổi.
- Cấu hình điểm danh của container trước chuyển trùng container đã xác minh trước đó. Sau chuyển, worker vẫn hiện diện và hàng `sync_portal_attendance` vẫn có 102 hoàn tất, 0 đến hạn/quá lease.

Chưa có lượt nộp bốn ChatGPT Share thật sau thay đổi để đọc lại dòng xác nhận trong Docs. Chưa có ca điểm danh mới trong lần phát hành này để đối chiếu độc lập outcome Portal; trạng thái toàn sản phẩm là `deployed_awaiting_validation`, không phải `verified`.

## Quay lại

Chỉ dùng khi có lỗi production được xác nhận. Dừng và giữ container mới, đổi tên container dự phòng về `mapping-review-api`, khởi động lại rồi kiểm health, module hash, cấu hình điểm danh và hàng đợi. Quay lại image không hoàn tác dữ liệu học viên đã nộp; đối chiếu các grant/biên nhận phát sinh sau chuyển trước khi đổi hành vi.
