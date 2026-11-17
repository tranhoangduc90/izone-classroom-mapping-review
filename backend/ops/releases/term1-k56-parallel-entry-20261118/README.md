# Ứng viên Term Test 1 K56: hai hồ sơ cùng người

Đây là bản chuẩn bị, **chưa phát production**. Giữ core skill-grant/hold riêng của Term 1, đáp án raw và Task 2; không thay bằng core Term 2. Source đầu vào lấy từ container đang phục vụ và được ghim bằng checksum trong hồ sơ GOAL Test riêng tư.

`stage.py` nhận thư mục source đã chụp và đích xuất overlay. Nó thêm capability Term 1, tạo hồ sơ độc lập, khóa theo người khi chọn bài chính thức và giữ định danh hồ sơ nguồn trong receipt/log. Chỉ seal hợp lệ mới giữ chỗ; báo gián đoạn đơn độc không giữ chỗ. Nộp tiếp kỹ năng từ hồ sơ khác vào đúng bài chính thức; grading Task 2 theo bài đó. Khi anchor source không khớp, script dừng để kiểm lại nền. Nền trước và sau bản sửa Term 2 K56 đều được chấp nhận ở đúng phần generation đã kiểm.

`build-migration.py` tạo migration bổ sung Term 1 và giữ loại trừ parallel của Term 2. `build-term2-valid-submission.py` giữ lịch sử bản sửa Term 2 được phát riêng trong thư mục `term2-k56-first-valid-20261118`; không coi nó là phần Term 1 đã phát. Các SQL không được tự áp dụng khi chạy stage.

Đã kiểm cách ly ngày 18/11: RED owner conflict trên nền; GREEN cả Nghe trước/Đọc trước, hai hồ sơ, Task 2, mất ACK sau commit, replay đúng receipt và một grading run/job. Kiểm thêm gián đoạn chưa giữ chỗ, generation trước seal, hai ca skill fallback cũ và PostgreSQL 16 với tranh khóa thật, bảo vệ đáp án và giữ Term 2. Ca generation đặt trạng thái bằng SQL, chưa qua endpoint Reset.

Còn phải ghép Pages capability, cache/tab cũ và hành trình/audio bị ảnh hưởng; kiểm native cloud và giới hạn Agent trước bật nguồn mới. Chỉ merge/phát gói Term 1 khi phần kiểm liên quan đã đủ. Không suy các ca SQL này thành giao diện, chấm AI thật hoặc tải vận hành. Nguồn/biên nhận chi tiết nằm trong kế hoạch GOAL Test ngày 16/11 và phần cập nhật 18/11 ở thư mục private-deployments của dự án.
