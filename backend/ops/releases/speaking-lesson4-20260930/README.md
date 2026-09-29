# Speaking Homework buổi 4: nhận bài và cập nhật Bác sĩ AI

## Học viên nhìn thấy gì

Học viên mở nút trong bản Docs của mình, chọn tên lớp IC2304 hoặc dùng tên đã nhớ từ Progress Log. Trang yêu cầu hai hội thoại Speaking: Chèn điểm giữa và Freestyle. Phần Bác sĩ AI hiện năm bài cần luyện đầu tiên theo thứ tự **Chờ luyện → Số lần đề xuất giảm dần → tên bài**; nút “Xem tất cả” mở phần còn lại. Học viên chọn hai bài tập khác nhau và nộp mỗi bài bằng một ChatGPT Share riêng. Nếu danh sách cá nhân chưa đủ hai bài, ô chọn có thêm **Kho bài chung** theo lựa chọn của Đức. Bài từ kho chung chỉ vào hồ sơ cá nhân khi hội thoại đạt. Bốn link đạt thì hệ thống cấp biên nhận và ghi về đúng Doc ID trong URL.

Sau khi đã nộp Homework, ô “Luyện thêm” trên cùng trang nhận từng hội thoại bổ trợ mới. Mỗi lượt có lịch sử riêng, không sửa biên nhận Homework. Khi bài Classroom đã đóng, chỉ học viên có biên nhận cũ gắn đúng Doc ID mới được vào lại để luyện thêm; học viên chưa nộp không thể bắt đầu mới.

## Hệ thống xử lý thế nào

1. Trang và API chỉ nhận `https://chatgpt.com/share/<id>`. Link `/c/` là hội thoại riêng; link `/s/t_…` chỉ chia sẻ một phản hồi. Hai loại này bị chặn trước khi nhận bài.
2. API lưu link với mã lớp, hồ sơ học viên đã chọn và Doc ID. Hàng kiểm đọc hội thoại ChatGPT Share, dùng AI xác định bài cá nhân đã được luyện thật và áp dụng vào một câu Speaking có câu trả lời, góp ý, rồi nói lại đầy đủ. Nếu nội dung không đạt hoặc link không mở được, học viên thấy lỗi và nộp lại.
3. Khi bài bổ trợ đạt, API tăng **Số lần luyện**, đưa bài đó khỏi **Chờ luyện**. Hàng phân tích tiếp tục ghép lỗi có dẫn chứng với danh mục Bác sĩ AI khóa 67, tăng **Số lần đề xuất** và mở lại **Chờ luyện** theo đúng luật năm ngày hiện hành. Khóa nguồn duy nhất ngăn lần thử lại cộng trùng.
4. Giáo viên mở link trong dòng xác nhận ở Docs, đăng nhập bằng quyền lớp để xem hai bài Speaking, hai bài bổ trợ bắt buộc, các lượt luyện thêm và tình trạng phân tích.

## Kích hoạt cho IC2304

Mẫu Docs mới: `1XUV5k6PjAAFjAwD8t_HdWRgVfjUF3WaUb2eZMh20Ivs`. Docs có đúng một CTA chữ trắng và ô tình trạng ngay dưới tiêu đề. Bài Classroom IC2304 `888120053939` đã được tạo bằng chế độ `STUDENT_COPY` và đọc lại ở trạng thái `DRAFT`; chưa phát cho học viên. Mã bài in trong mẫu là `67-speaking-diem_giua` và là mã chuẩn của đường mở webapp. Nguồn Docs cũ `1ndj3S00OxlwJ39HxrQIgZVnGa5hI1hkz8Fy4hHzPUnk` chỉ dùng để đối chiếu hướng dẫn bài luyện. Bản sao nội bộ `1GHzDQNRPF8kctqgQxLBQqq_gjY8RGRSy3nT3zm3xkqY` đã qua thử CTA và ghi trạng thái với biên nhận giả; bản này không thuộc Classroom và không được dùng làm bài học viên.

Trước khi mở: backup database mapping; áp dụng migration `202609290003_speaking_lesson4_practice.sql` trước bản API mới; xác minh hai phần `insert_middle` và `freestyle` đều có `min_questions=3`, `required_practice_count=2`, `doctor_course_key='67'`, class ID lấy từ mapping IC2304 đã duyệt. Gắn CTA theo sự kiện bản sao Classroom với `assignmentCode=67-speaking-diem_giua`, `class=IC2304` và Doc ID của chính bản sao. Đọc lại nút CTA giữ chữ trắng không gạch dưới và ô vàng dưới “TÌNH TRẠNG NỘP BÀI SPEAKING”. Kiểm Kho bài chung có đủ hai bài đang hoạt động để mọi học viên đều chọn được hai bài khác nhau. Lúc kiểm 30/09, 6/15 học viên IC2304 có dưới hai đề xuất cá nhân.

API dùng chung với Progress Log. Trước và sau chuyển bản phải đối chiếu image, cấu hình điểm danh, worker `sync_portal_attendance`, hàng chờ và kết quả Portal; giữ container cũ để quay lại. Bốn Share Đức cung cấp đã được đọc và kiểm cục bộ: Chèn điểm giữa đạt ba giai đoạn, Freestyle đạt ba câu, hai bài bổ trợ khớp bài thật trong Kho và đều đạt bước áp dụng vào Speaking. Bài giới từ có cảnh báo cách luyện nói cần học viên xác nhận; kết luận AI có thể thay đổi giữa các lần gọi. Còn phải thử bản sao Docs, biên nhận, teacher view và `doctor_recommendation` trên đường tích hợp. Không tuyên bố đã vận hành thật khi bài Classroom còn ở trạng thái nháp hoặc chưa có phép thử hoàn chỉnh.

## Khi lỗi

- Link chưa đạt: học viên sửa hoặc nộp hội thoại mới; bài chưa có biên nhận.
- Hàng AI lỗi: link đã lưu, trạng thái đang xử lý/lỗi; người vận hành xem `practice_check_job` và `practice_analysis_job`, thử lại theo job ID, không tự cộng đề xuất bằng tay.
- Danh sách Bác sĩ AI chưa đủ hai bài: hiển thị Kho bài chung có nhãn riêng; học viên tự chọn bài phù hợp, không tự ghi thành đề xuất cá nhân trước khi họ luyện đạt.
- Cần quay lại API: dùng container và bản database đã backup; dữ liệu học viên phát sinh sau chuyển phải được đối chiếu trước, không xóa hàng loạt.
