# Bằng chứng phần Writing thay đổi trong image K56

Hai file `*.patch.json` giữ nguyên từng dòng của bản so sánh trước/sau, kể cả ký tự xuống dòng gốc. Đọc trường `lines` rồi nối theo thứ tự bằng chuỗi rỗng sẽ khôi phục byte UTF-8 ban đầu; SHA256 phải khớp `original_sha256`. JSON giúp giữ nguyên các dòng trống và ký tự CR của source lịch sử trong Git. Hai bản đã được đọc lại và so khớp toàn bộ byte sau chuyển định dạng.

Các file này là bằng chứng so sánh. Adapter phát hành dùng đúng image bất biến trong `candidate.json`, kiểm lại hash mọi file source và cấu hình live trước thao tác. Không dựng lại candidate từ patch hoặc coi patch là bằng chứng Git đã dựng image gốc.

Bộ kiểm `exercise_canary_docker.py` chạy ba image candidate với PostgreSQL giả riêng trong mạng Internal, chỉ khởi tạo API bằng `createApp`. Bộ đếm chấm/Portal là giả, phải bằng 0. Receipt này chứng minh API/SQL/producer và cleanup fixture; production, browser, Apps Script và điểm danh vẫn có biên nhận riêng.

## Bổ sung quyền quản trị demo, Đức duyệt 04/10

`demo-admin.patch.json` giữ đúng diff của auth và SQL từ candidate D08 trước. Hai file được đọc lại trong image mới, 31 file source/package còn lại khớp byte. Admin có quyền toàn lớp từ role đã xác thực; giáo viên vẫn theo cờ/phân công. Nhãn lớp phân biệt được phân công và quyền quản trị. Không migration, sửa tài khoản hay thay grader/prompt. Cùng fixture SHA48c4c60d: RED6/8 trên image cũ, GREEN8/8 trên image mới; expanded11/11. Image bất biến trong candidate.json là đích mới; checkpoint bundle/production còn phải qua cổng.
