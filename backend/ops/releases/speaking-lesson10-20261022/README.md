# Overlay Homework Speaking Lesson 10

Thêm hai phần `story_context` và `story_sequence` cho mã `67-speaking-ke_chuyen_boi_canh_truoc_trong_sau`, cùng route CTA Lesson 10. Danh mục/Bác sĩ AI, hai bổ trợ, lịch sử cá nhân, danh tính và tự nộp dùng thành phần hiện hành.

`speaking-checker.js`, `speaking-classroom-copies.js`, `speaking-completion-policy.js` là overlay trên **exact source của image Speaking độc lập đọc ngày 22/10/2026**. Module mới `src/speaking-story-checker.js` dùng snapshot và chính sách công nhận chung; bài cũ tiếp tục bộ điều phối live. Không rebuild toàn main từ gói này vì source runtime có các cập nhật chưa nằm trọn trong checkout main.

Đầu vào checker là một ChatGPT Share và phần bài. AI tìm dẫn chứng; bộ kiểm đối chiếu tin/câu/vai trò/thứ tự, rồi công nhận một lượt đầy đủ. Bối cảnh cần ba tình huống; Trình tự cần O-B-D-A, mỗi phần ba câu. Lỗi đọc hoặc phân tích trả trạng thái cần kiểm lại, không tạo receipt. Lời chatbot xác nhận hoàn thành kế thừa chính sách đang chạy.

Khi phát hành, chỉ phủ bốn module lên image live: ba file overlay và `src/speaking-story-checker.js`. Giữ mọi source khác, env, quyền và mount OAuth đọc Docs. `src/speaking-conversation-snapshot.js` đã có trên runtime live, được đưa về source để dependency của checker mới đầy đủ.

Migration chuẩn ở repo mapping-database: `202610220315_speaking_lesson10_story.sql`. Hai workflow CTA/cảnh báo chỉ thêm mã trong registry. Không thay container API chung/Progress Log hoặc tự giao Classroom. Sau phát hành phải đọc lại catalogue, mở trang thật, và đối chiếu từng CTA khi Homework đã được giao.

Bằng chứng chuẩn bị riêng tư trên máy Đức: `E:/Codex-Data/speaking67-lesson10-20261022/`. Không chép exact workflow, nội dung Share nguồn hoặc dữ liệu học viên vào repo.
