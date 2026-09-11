# Vé thi bù Listening cho Term Test

Bản phát hành này bổ sung vé thi bù có chữ ký cho một học viên, một lớp và một bài thi cụ thể.

- Đầu vào: frontend gửi `retakeGrant` cùng mã lớp và mã học viên sau khi học viên xác nhận tên.
- Xử lý: API kiểm chữ ký, phạm vi và hạn dùng trước khi đọc hồ sơ; vé hợp lệ tạo hoặc mở lại đúng một phiên mới có UUID nằm trong vé, không nối kết quả Term Test cũ.
- Đầu ra: phiên Listening mới dùng luồng chấm và đồng bộ Portal hiện có. Payload điểm chỉ có Listening nên Reading và Writing không bị ghi đè.
- Khi lỗi: vé sai, hết hạn hoặc không đúng học viên bị từ chối; xung đột phiên dừng an toàn thay vì mở một lượt khác.

Image được tạo theo kiểu lớp phủ trên image đang chạy `mapping-review-api:learning-audio-resume-20260910`. Script build kiểm SHA-256 của hai file nguồn trước và sau khi áp dụng để tránh vá nhầm phiên bản. Không có bí mật, vé thật hoặc dữ liệu học viên trong thư mục này.

Kiểm thử trước phát hành:

```text
$env:RETAKE_SOURCE_ROOT='<THƯ_MỤC_SOURCE_ĐÃ_ÁP_DỤNG_OVERLAY>'
node --test test/listening-retake-grant.test.js
3 passed, 0 failed
```

Rollback: chạy lại cùng chuỗi Compose hiện hành nhưng bỏ `compose.override.yml` của bản phát hành này; container quay về image `mapping-review-api:learning-audio-resume-20260910`.
