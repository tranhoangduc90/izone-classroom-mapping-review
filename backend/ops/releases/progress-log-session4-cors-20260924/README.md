# Sửa lỗi gửi nhận xét Speaking · IC2305 Buổi 4

## Triệu chứng và nguyên nhân

Trên màn giảng viên production, bấm **Gửi nhận xét** báo `Failed to fetch`. Yêu cầu kiểm tra của trình duyệt (CORS preflight) trả `204` nhưng `Access-Control-Allow-Methods` thiếu `PUT`; trình duyệt chặn request trước khi vào endpoint. Bài làm thử và bản nháp vẫn được lưu.

## Thay đổi

Thêm `PUT` vào header CORS của API. Không sửa endpoint, quyền đăng nhập, dữ liệu phiếu hoặc các phương thức hiện có. Test `learning-feedback-cors.test.js` thất bại trên base `896d11f` và đạt sau sửa; full suite đạt 168/168.

## Phát hành và hoàn tác

1. Dựng image từ image đang chạy bằng Dockerfile có hash guard cho `app.js` cũ và mới.
2. Chạy `deploy-api.sh`: giữ container hiện tại làm bản hoàn tác; truyền biến môi trường qua file descriptor, không in hoặc lưu secret; health check không đạt thì khởi động lại bản cũ.
3. Đọc lại header preflight trên URL thật, sau đó mở bài của **hồ sơ kiểm thử tạm** và gửi nhận xét Speaking qua giao diện giảng viên.
4. Tạo link tổng hợp, xác nhận chỉ hồ sơ kiểm thử đọc được nhận xét. Xóa riêng dữ liệu của hồ sơ kiểm thử theo thứ tự FK; kiểm roster về 18, bài nộp và nhận xét thử đều bằng 0. Không nộp phiếu cuối để tránh job điểm danh Portal.

Nếu lỗi sau khi chuyển image, giữ dữ liệu test để điều tra trong thời gian ngắn và hoàn tác API bằng container đã lưu. Không xóa dữ liệu học viên thật.
