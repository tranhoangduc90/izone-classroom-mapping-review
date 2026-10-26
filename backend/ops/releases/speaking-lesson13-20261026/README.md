# Homework Speaking Lesson 13 — tả vật

Trạng thái: đã chuyển production ngày 26/10/2026 sau xác nhận trong chat; image `sha256:57bc5e436e4ccb7961a36e6efc376b92529ab6c5f545c012fa474ed0d6cbb300` healthy. Readback đủ source/config/mount/network, các dịch vụ khác giữ ID/image.

Nguồn: Google Docs `1toXQeyiPjfAPTh1Y4gJ0jTuHZZK-yp6Vf7UTrBIE1Rg`, tab `t.0`, đọc ngày 26/10/2026. Hai chatbot nguồn đã đọc từ Short.io; không tạo hoặc thay prompt. `object_intro` yêu cầu hai lượt giới thiệu vật và câu chuyện nguồn gốc; `object_description` yêu cầu một lượt Giác quan → Nội dung nếu có → Công năng. Nội dung có thể bỏ qua khi vật không phù hợp, không bắt năm giác quan hoặc thử thách tùy chọn. Kế thừa Doctor khóa `67`, hai bài bổ trợ khác nhau và luyện thêm như Lesson 11.

Bốn module trong thư mục này là overlay trên exact image Speaking độc lập `sha256:7ecce3c5f14bd18c27af6f0e8125424631ec4c741025ffcfbbe36362db6767cb`. Không dùng toàn main để dựng image: checker live có thêm hành vi của các buổi cũ chưa được ghép đủ vào canonical. `speaking-object-checker.js` mới; checker chỉ thêm dispatch, copies thêm route, progress thêm nhãn và đơn vị lượt cho hai part mới. Mọi module khác phải giữ nguyên hash. Giữ OAuth mount, env, cấu hình mạng, worker Docs và recognizer v3. Chỉ chuyển `speaking67-independent-api`; không chuyển Mapping API/Progress Log/broker.

AI đề xuất dẫn chứng từng bước; máy chủ kiểm nguyên văn, vai trò, thứ tự và các lượt không dùng lại câu trả lời. Lỗi AI/đọc Share giữ chưa xác minh. Lời chatbot xác nhận hoàn tất cả bài dùng policy chung, không thêm ngưỡng phụ; mốc giữa bài vẫn bị chặn. Snapshot dùng trần chung 160.000 ký tự. Accepted từng phần có tiến độ Docs trước receipt; bộ tự nộp và khóa đúng chủ giữ nguyên.

Kiểm cục bộ: `backend/test/speaking-object.test.js`, regression completion/long snapshot/progress/story/independent trên exact-live candidate, SQL PGlite thêm/chạy lại/xung đột và service giữ Doctor/receipt. Frontend dùng renderer thật, API giả, Lesson 4/11/13 tại 390/768/1440px. Chi tiết và giới hạn: `E:/Codex-Data/speaking67-lesson13-20261026/`. Chưa kiểm AI, Google Docs/Classroom và bài học viên thật đầu cuối.

Sau duyệt: build overlay, kiểm image không mạng và clone cấu hình đã dừng, sao lưu, chuyển container, đọc lại đủ source/config/hash và API public. Giữ container trước chuyển ở tên `speaking67-independent-api-before-speaking13-20261026`. Catalogue migration `202610261545`, registry hai workflow và Pages là các phần phát hành riêng. Quay code bằng image đã kiểm và catalogue/registry có kiểm scope; giữ mọi bài/receipt mới, không restore dump cũ để quay code.

Readback API: cùng 10 lớp như Lesson 11, cả 10 ready và roster đúng ngưỡng 2/1, hai bổ trợ, Doctor bật. Image có 21/21 test đạt; regression exact candidate 65/66 đạt, 0 lỗi, 1 skip ca tải PostgreSQL native. Browser sau ghép Lesson 12 có sáu hành trình Lesson 12/13 đạt. Những giới hạn AI/Google/Classroom thật ở trên vẫn giữ.
