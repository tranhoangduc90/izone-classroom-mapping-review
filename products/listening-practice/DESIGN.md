# Thiết kế vận hành Listening buổi 8

## Phạm vi và hành trình

Học viên mở link gắn với đúng tài liệu, chọn đúng lớp và học viên. Chỉ bài đang mở và CTA đã kiểm mới vào được. Bắt đầu tạo lượt, tải audio có xác thực, nhận quyền điều khiển rồi phát. Năm câu trắc nghiệm 21–25 và năm câu sơ đồ 26–30 dùng ngân hàng A–H. Đáp án/giải thích chỉ trả sau nộp.

## Thời gian và phục hồi

Audio 459207 ms, rà bài 120000 ms, tổng 579207 ms. Không có đồng hồ đọc đề riêng. Tải audio và chờ phản hồi kích hoạt chưa tính thời gian nghe; xác nhận đầu tiên dùng thời gian phát thực tế, sau đó máy chủ giữ đồng hồ. Vị trí audio không được nhảy vượt đồng hồ, tua lại hoặc chuyển sớm sang rà bài. Rà bài chỉ bắt đầu khi audio kết thúc.

Nhịp lưu 5 giây, quyền điều khiển 7 giây. Mất mạng, ẩn trang, pause hoặc tab khác lấy quyền sẽ dừng audio và che đề. Resume giữ đáp án, ghi chú và vị trí. Snapshot có thứ tự; yêu cầu nộp/reset có mã chống ghi lặp. SQL khóa lượt để nộp và reset đồng thời chỉ có một hành động thắng.

## Tải, giới hạn và xử lý lỗi

Mốc kiểm 30 phiên đồng thời, khoảng 6 lần lưu/giây. Audio 7,35 MB tải trọn vào trình duyệt, khoảng 220 MB cho 30 người bắt đầu cùng lúc; tải tối đa 20 giây, thất bại giữ lượt để thử tiếp. API/DB/nguồn quyền lần lượt giới hạn RAM 256/256/128 MiB, CPU 0,5/0,5/0,25. Không suy kiểm fixture thành kiểm đủ tải mạng hoặc thiết bị thật.

Nguồn quyền lớp được cache 120 giây, chỉ đọc view riêng trong mapping_db. API Google Docs chờ tối đa 10 giây. Hàng ghi có thứ tự theo học viên, khóa xử lý 60 giây; retry tăng dần tối đa 300 giây, sau 8 lỗi chuyển blocked. Ghi xong đọc lại chữ/link. Ô bị sửa tay hoặc sai tài liệu/tab/mã bài được giữ để giảng viên xử lý.

## Ranh giới và kiểm

Database listening_practice_db, schema listening_practice, role ứng dụng riêng; role listening_owner_reader chỉ đọc view listening_owner_api_v1. Runtime, cấu hình, volume, cổng 8818/8819 và route /listening-practice-api/ riêng. Dùng chung tài nguyên VPS và dữ liệu quyền nguồn, không dùng runtime Reading.

Kiểm SQL, tranh chấp 30 phiên, trình duyệt nối API, mất mạng, nhiều tab, reset, màu giải thích và ghi/đọc Google Docs trên tài liệu canary riêng. Sau phát hành đối chiếu image/cấu hình/thời điểm chạy của Reading và Term Test với trước phát hành. Chưa mở lớp khi chưa chọn lớp và nguồn tài liệu; Google đăng nhập người thật cần kiểm riêng khi mở lớp.
