# Phát hành Speaking Homework Lesson 2 · IC2304

## Phạm vi và kết quả

- Nguồn bài: Classroom `826336470852`, Homework Lesson 2 `873394669810`, 15 bản sao Docs. Mã bài chính thức: `67-speaking-paraphrase`.
- Học viên mở URL chung, chọn tên trong danh sách lớp đã duyệt (hoặc dùng tên đã ghi nhớ), rồi nộp hai hội thoại riêng: Paraphrase ít nhất 5 câu hỏi và Full Speaking ít nhất 3 chu trình.
- Backend kiểm URL ChatGPT Share toàn hội thoại, nội dung thật, số câu, cảnh báo gõ, trùng URL/nội dung và lịch sử trong khóa. Chỉ đủ hai phần mới cấp biên nhận; kết quả phân tích cập nhật Bác sĩ AI cho đúng học viên.
- Giữ nguyên nội dung 15 Docs cũ và trạng thái Classroom cũ. Trang hiển thị biên nhận và nút quay lại đúng Docs; không ghi thông điệp mới vào Docs, không quét lại bài cũ để gửi email giảng viên.
- Bản ghi bài cũ hiện mang mã tạm `67-speaking-lesson2-legacy`, trạng thái đóng, đã có 21 claim hội thoại. Chuyển chính bản ghi này sang mã chính thức để giữ chống nộp lại.

## Hành trình và ranh giới

1. Trang gọi API theo mã lớp + mã bài, nhận danh sách học viên thật, không nhận tên/ID Docs từ mã nguồn public.
2. Khi chọn học viên, API tìm đúng một bản sao Docs đã ghép bằng Classroom user ID và cấp phiên. Học viên khác trong lớp không thể mở bản sao này qua tuyến trực tiếp.
3. Từng link được lưu, đọc hội thoại và kiểm qua hàng việc; kết quả được đọc lại, kể cả khi đóng/mở trang. Hai link đạt tạo một receipt duy nhất.
4. Hàng chấm và Bác sĩ AI chạy sau receipt; lỗi từng việc giữ receipt và cho vận hành thử lại. Bài cũ đã trả lại không bị đọc/quét lại.

## Thiết kế vận hành

- Tải ước lượng: tối đa 15 học viên lớp IC2304, một hoặc vài đợt dùng đồng thời; hệ thống dùng giới hạn/hàng việc Speaking hiện có.
- Trang báo đang kiểm và tự đọc lại; một lượt AI có timeout 45 giây, job retry/lease theo API hiện hành. Mất mạng giữ link đang gõ trên thiết bị và không báo đã nộp khi chưa có receipt.
- Nguồn định danh: `course_id + course_work_id` xác định assignment; Classroom `userId` ghép `student_ref + document_id`; `student_ref` xác định Bác sĩ AI. Mọi ghép phải duy nhất; sai/missing thì dừng.
- Biên nhận duy nhất và claim URL/fingerprint bảo vệ retry/trùng. Chế độ buổi 2 bỏ riêng việc ghi Docs; không ảnh hưởng buổi 3/4 mặc định vẫn ghi Docs.
- Theo dõi: số Docs ghép, phiên/bài đã nộp, check job/outbox pending/failed, cập nhật doctor, API lỗi. Không bật lịch cảnh báo Classroom cho bài lịch sử.
- Quay lại: tắt trạng thái bài, giữ dữ liệu/receipt đã sinh; revert mã ứng dụng và cấu hình DB có điều kiện sau khi đối chiếu dữ liệu mới, không xóa bài học viên.

## Điều kiện nghiệm thu

- 15/15 Docs ghép duy nhất, roster khớp lớp; mã bài đúng và claim lịch sử 21/21 còn nguyên.
- Link `/c/`, `/s/t_`, domain giả, Share không mở được, nội dung thiếu và hội thoại đã dùng trước bị chặn. Hai phần hợp lệ tạo đúng một receipt; mở lại vẫn thấy bài.
- Giữ nguyên 15 Docs/ trạng thái Classroom; không có outbox `write_doc` hay email hồi tố cho buổi 2.
- Bộ kiểm backend đầy đủ, browser desktop/mobile, bản production đọc lại URL/API/database. Trước/sau đổi API chung kiểm worker điểm danh Progress Log và phiên đăng nhập giảng viên.

Phạm vi nghiệm thu: `large_phased`; phần lõi nộp và các bất biến phải kiểm đầy đủ. Phân tích Bác sĩ AI cần readback theo receipt thử được phép trước khi gọi `verified`.
