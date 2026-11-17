# Term Test 2 K56: lần nộp hợp lệ đầu tiên

Hồ sơ A chỉ báo gián đoạn Listening chưa được giữ chỗ bài chính thức. Hồ sơ B phải mở và nộp một bài hợp lệ được. Bản đang phục vụ chọn cả dòng gián đoạn làm bài chính thức, khiến B nhận HTTP 200 nhưng không có biên nhận bắt đầu. Gói sửa bỏ dòng chỉ gián đoạn khỏi phép chọn và cờ chính thức; giữ toàn bộ nội dung, thời gian, lịch sử và biên nhận. Hồ sơ mới còn kế thừa thế hệ hiện hành nếu chưa có bài nộp hợp lệ.

Đây là overlay từ đúng source đang phục vụ, không dựng lại backend từ main. `stage.py` nhận thư mục source đã chụp và xuất hai module sửa. Nó kiểm đúng một vị trí thay thế, dừng nếu nền không khớp. Term 1, Mini, fallback kỹ năng và nhật ký native giữ nguyên. Chưa bật hành trình Term 1 mới.

## Bằng chứng ngày 18/11/2026

- Ca HTTP/SQL cách ly trên source đang phục vụ tái hiện lỗi gián đoạn. Gói riêng sửa đạt bốn ca: gián đoạn chưa giữ chỗ; kế thừa generation; hai hồ sơ với Nghe trước; hai hồ sơ với Đọc trước. Hai ca cuối kiểm Task 1, mất ACK sau commit, biên nhận retry, một grading run và một job đúng bài chính thức.
- `first-valid.test.mjs` chạy PostgreSQL 16 cách ly, giữ nguyên mọi trường ngoài cờ lỗi, bảo vệ đáp án đã nộp và cho hai giao dịch thật tranh khóa để chứng minh chỉ một bài chính thức. Dùng đúng URL/confirmation fixture local được ghim trong tệp; không nhận DB production. PostgreSQL thử đã dừng sau kiểm.
- Các kết quả trên không thay bằng chứng giao diện, nghe đủ thời lượng, chấm AI thật hay tải vận hành. Bằng chứng các phần không đổi được giữ trong hồ sơ GOAL Test riêng tư.

## Phát và quay lui

`deploy.py` chạy tại thư mục VPS được ghim trong tệp, mỗi lần một bước `inspect`, `stage`, `migrate`, `switch`. Đầu vào là manifest checksum, hai module và SQL đã kiểm. Đầu ra là biên nhận riêng từng bước. Lỗi build, checksum, lượt đang làm, job chấm, khóa bảng hoặc thay đổi dữ liệu ngoài cờ đều dừng bước và báo lỗi.

Ứng viên kế thừa image, môi trường, mọi mount và giới hạn container đang phục vụ, chỉ thay hai module và BUILD_SHA. Nó nghe loopback 19806. Trước đổi proxy, so health, route cấp vé browser, hai kiểu origin và checksum. Migration giữ unique index, bảo vệ payload và so dấu vân tay toàn bảng trong cùng giao dịch trước commit. Snapshot hàm cũ và cờ cần chỉnh nằm riêng trên VPS, không chứa trong Git.

`rollback` phục hồi proxy tới loopback 19803 sau khi xác minh không có lượt hoặc job chấm đang chạy. Nếu kiểm sau chuyển lỗi, proxy tự quay về. Bản sửa SQL tương thích được giữ lại; không phục hồi nội dung bài hoặc cờ theo snapshot cũ vì có thể ghi đè bài mới đã nhận. Agent, cấu hình cloud, Pages và các cửa sổ ngân sách không thay đổi trong gói này.
