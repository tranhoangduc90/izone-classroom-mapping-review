# Speaking Homework buổi 4: nhận bài và cập nhật Bác sĩ AI

## Học viên nhìn thấy gì

Học viên mở nút trong bản Docs của mình, chọn tên lớp IC2304 hoặc dùng tên đã nhớ từ Progress Log. Trang yêu cầu hai hội thoại Speaking: Chèn điểm giữa và Freestyle. Phần Bác sĩ AI hiện năm bài cần luyện đầu tiên theo thứ tự **Chờ luyện → Số lần đề xuất giảm dần → tên bài**; nút “Xem tất cả” mở phần còn lại. Học viên chọn hai bài cá nhân khác nhau và nộp mỗi bài bằng một ChatGPT Share riêng. Bốn link đạt thì hệ thống cấp biên nhận và ghi về đúng Doc ID trong URL.

Sau khi đã nộp Homework, ô “Luyện thêm” trên cùng trang nhận từng hội thoại bổ trợ mới. Mỗi lượt có lịch sử riêng, không sửa biên nhận Homework. Trang vẫn cần bài Classroom ở trạng thái mở để học viên vào lại; nếu cần nhận bài sau khi bài đã đóng, phải xây cổng Bác sĩ AI độc lập và xác định lại quyền truy cập.

## Hệ thống xử lý thế nào

1. Trang và API chỉ nhận `https://chatgpt.com/share/<id>`. Link `/c/` là hội thoại riêng; link `/s/t_…` chỉ chia sẻ một phản hồi. Hai loại này bị chặn trước khi nhận bài.
2. API lưu link với mã lớp, hồ sơ học viên đã chọn và Doc ID. Hàng kiểm đọc hội thoại ChatGPT Share, dùng AI xác định bài cá nhân đã được luyện thật và áp dụng vào một câu Speaking có câu trả lời, góp ý, rồi nói lại đầy đủ. Nếu nội dung không đạt hoặc link không mở được, học viên thấy lỗi và nộp lại.
3. Khi bài bổ trợ đạt, API tăng **Số lần luyện**, đưa bài đó khỏi **Chờ luyện**. Hàng phân tích tiếp tục ghép lỗi có dẫn chứng với danh mục Bác sĩ AI khóa 67, tăng **Số lần đề xuất** và mở lại **Chờ luyện** theo đúng luật năm ngày hiện hành. Khóa nguồn duy nhất ngăn lần thử lại cộng trùng.
4. Giáo viên mở link trong dòng xác nhận ở Docs, đăng nhập bằng quyền lớp để xem hai bài Speaking, hai bài bổ trợ bắt buộc, các lượt luyện thêm và tình trạng phân tích.

## Kích hoạt cho IC2304

Nguồn Docs cũ: `1ndj3S00OxlwJ39HxrQIgZVnGa5hI1hkz8Fy4hHzPUnk`. Đây chưa phải mẫu mới có CTA và ô trạng thái; không dùng Doc nguồn cũ làm bản sao giao bài. Chờ mẫu Docs mới do Đức gửi, rồi tạo bài Homework Lesson 4 trong Classroom và xác định `course_work_id` thật.

Trước khi mở: backup database mapping; áp dụng migration `202609290003_speaking_lesson4_practice.sql` trước bản API mới; xác minh hai phần `insert_middle` và `freestyle` đều có `min_questions=3`, `required_practice_count=2`, `doctor_course_key='67'`, class ID lấy từ mapping IC2304 đã duyệt. Gắn CTA theo sự kiện bản sao Classroom với `assignmentCode=67-speaking-chen_diem_giua`, `class=IC2304` và Doc ID của chính bản sao. Đọc lại nút CTA giữ chữ trắng không gạch dưới và ô vàng dưới “TÌNH TRẠNG NỘP BÀI SPEAKING”. Không mở assignment nếu một học viên chưa có ít nhất hai bài cá nhân trong danh sách, hoặc cần chốt cách xử lý ngoại lệ đó trước.

API dùng chung với Progress Log. Trước và sau chuyển bản phải đối chiếu image, cấu hình điểm danh, worker `sync_portal_attendance`, hàng chờ và kết quả Portal; giữ container cũ để quay lại. Sau chuyển, thử một bản sao Docs và bốn Share hợp lệ bằng hồ sơ được phép thử, đọc lại biên nhận, đúng file Docs, teacher view và `doctor_recommendation`. Không tuyên bố đã vận hành thật khi chưa có bài Classroom/mẫu Docs mới và phép thử hoàn chỉnh.

## Khi lỗi

- Link chưa đạt: học viên sửa hoặc nộp hội thoại mới; bài chưa có biên nhận.
- Hàng AI lỗi: link đã lưu, trạng thái đang xử lý/lỗi; người vận hành xem `practice_check_job` và `practice_analysis_job`, thử lại theo job ID, không tự cộng đề xuất bằng tay.
- Danh sách Bác sĩ AI chưa đủ hai bài: dừng phát bài cho học viên đó; kiểm dữ liệu đề xuất nguồn và làm rõ cách bổ sung, không hiển thị bài ngẫu nhiên.
- Cần quay lại API: dùng container và bản database đã backup; dữ liệu học viên phát sinh sau chuyển phải được đối chiếu trước, không xóa hàng loạt.
