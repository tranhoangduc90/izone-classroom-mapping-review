# Tự gắn link chung Listening vào Homework

Workflow `f9JNQ9Vui36U8Tz5` tiếp tục gửi từng sự kiện Docs tới `POST /api/admin/register-cta`. Nhánh Listening đã nhận toàn bộ event gốc, kiểm đúng một Doc và chấp nhận trạng thái `verified`/`not_applicable`; không cần thay node, trigger, credential hoặc connection n8n để thêm Buổi 10. Đã đối chiếu bản live `d3cfcfd9-e865-4395-be44-4a2201740e74`, 40 node.

## Docs mẫu và giao bài

Giữ CTA `NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP LISTENING`; ngay dưới là một dòng mã `67-practice-listening_c20_t3_p4_inclusive_design`. Mã chỉ xuất hiện một lần, trong cùng tab. Khi giao Classroom dùng bản sao riêng từng học viên. Tên `Homework Lesson 10` giúp nhánh tìm lại đích nếu học viên đã làm trước khi giao.

API đọc mã trong Docs, không chọn buổi từ hyperlink mẫu cũ. Mã Buổi 10 dùng phiên bản đang ghim trong `shared_lesson` và gắn URL chung:

https://tranhoangduc90.github.io/izone-ai-team-pages/listening-practice/?lesson=67-practice-listening_c20_t3_p4_inclusive_design

Mã Buổi 8 `67-practice-listening_mcq_flowchart` vẫn dùng đăng ký/link cá nhân cũ. Các mã Reading/chấm bài cũ không đổi nhánh.

## Đúng người và giữ bài đã làm

Nguồn sự kiện giữ course/coursework/submission/Google user/Doc. API đối chiếu Google user với UUID/lớp đã duyệt, rồi kiểm bản Docs thực sự nằm trong submission của người đó và có đúng CTA/mã/tab. Sai người/lớp, nhiều mã hoặc đích đã gắn sang hồ sơ khác đều dừng trước ghi.

Buổi 10 giữ binding ở chế độ shared, lưu đích cá nhân trong `owner_proof.homework`; không chuyển sang link cá nhân. Dùng lại binding nếu học viên đã đăng nhập/làm trước. Đăng ký chỉ thêm job CTA sequence 0; không tạo lượt, reset, chấm lại hoặc sửa state/điểm. Job trạng thái bắt đầu/hoàn thành vẫn ghi đúng Docs đó sau đối chiếu lại chủ.

Chỉ thay hyperlink, màu chữ và gạch chân của CTA Listening. Worker khóa revision, đọc lại đúng link rồi mới trả verified. Chạy lại cùng sự kiện dùng cùng binding/job/link và không ghi Docs nếu đã đúng. Giữ chữ/link tay và trạng thái sẵn có ngoài CTA.

## Kiểm và quay lại

Regression `test/shared-cta.test.js` tái hiện mã mới bị từ chối trên base; bản sửa kiểm hai học viên trùng tên, retry đảo thứ tự/đồng thời, binding/lượt trước khi giao, ghi status đúng Docs và từ chối chuyển đích. Chạy cùng full suite Listening và native PostgreSQL canary riêng; Google Docs demo là adapter đích được chỉ định, không phải submission Classroom Buổi 10 thật.

Phát hành chỉ thay `src/cta-registration.js` và `src/service.js` trên image Listening live đã ghim. Backup image/cấu hình/source/DB trước chuyển. Giữ cổng host 18818 → container 8818 và toàn bộ mount/media catalog; không giải nén đè Compose. Quay lại image trước, giữ DB/schema/bài làm; không phục hồi dump đè dữ liệu mới. Workflow n8n và Classroom không bị sửa bởi gói backend này.
