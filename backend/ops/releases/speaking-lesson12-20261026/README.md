# Homework Speaking Lesson 12 — gói phát hành hẹp

Thêm phần **Kết cục và ý nghĩa** (`story_outcome`) và ánh xạ CTA Lesson 12, kế thừa `story_sequence`, hai bài bổ trợ và Bác sĩ AI từ Lesson 11. Bài dùng tiếp recognizer v3, snapshot 160.000 ký tự, worker tiến độ Docs và tự nộp hiện hành.

Prompt nguồn: tài liệu Google Docs Đức cung cấp; chatbot được đọc lại qua liên kết `ke_chuyen_ket_cuc`. Một lượt gồm ba tình huống có hướng dẫn, ba tình huống bán tự do, kể tóm tắt Part 2 và tự ghép đoạn kết có cầu nối bài học. Đề luyện thêm sau tổng kết là tùy chọn; nói hoặc gõ đều được nhận.

Ba module trong thư mục này là overlay lên exact source của image Speaking độc lập `sha256:a42f0b634b8bf42ce3809fc7348c6d028a058031b39a43b0b033593301b681c1`. Không rebuild toàn main hoặc đổi API chung/Progress Log. Trước chuyển bản phải đối chiếu baseline ID/image/config; giữ OAuth mount, env, network và container trước chuyển để quay lại. Không restore database cũ để quay code.

Kiểm đã đạt trước phát hành: 26 ca checker kể chuyện, 11 CTA các buổi, 33 ca xác nhận/snapshot/Docs; SQL thêm/chạy lại/xung đột giữ 10 template cũ; PGlite service bốn phần, receipt chống trùng và lịch sử Doctor. Browser 33 hành trình Lesson 2–12 tại 390/768/1440px với API giả đạt. Bằng chứng riêng: `E:/Codex-Data/speaking67-lesson12-20261026/`.

Trạng thái ban đầu: **đã chuẩn bị, chưa chuyển runtime production**. AI/Docs/Classroom của học viên thật chưa kiểm; kiểm AI mô phỏng và readback public có biên nhận riêng. Catalogue, registry n8n, Pages và runtime có trạng thái phát hành riêng.
