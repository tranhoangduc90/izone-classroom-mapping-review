# Bằng chứng phần Writing thay đổi trong image K56

Hai file `*.patch.json` giữ nguyên từng dòng của bản so sánh trước/sau, kể cả ký tự xuống dòng gốc. Đọc trường `lines` rồi nối theo thứ tự bằng chuỗi rỗng sẽ khôi phục byte UTF-8 ban đầu; SHA256 phải khớp `original_sha256`. JSON giúp giữ nguyên các dòng trống và ký tự CR của source lịch sử trong Git. Hai bản đã được đọc lại và so khớp toàn bộ byte sau chuyển định dạng.

Các file này là bằng chứng so sánh. Adapter phát hành dùng đúng image bất biến trong `candidate.json`, kiểm lại hash mọi file source và cấu hình live trước thao tác. Không dựng lại candidate từ patch hoặc coi patch là bằng chứng Git đã dựng image gốc.

Bộ kiểm `exercise_canary_docker.py` chạy ba image candidate với PostgreSQL giả riêng trong mạng Internal, chỉ khởi tạo API bằng `createApp`. Bộ đếm chấm/Portal là giả, phải bằng 0. Receipt này chứng minh API/SQL/producer và cleanup fixture; production, browser, Apps Script và điểm danh vẫn có biên nhận riêng.
