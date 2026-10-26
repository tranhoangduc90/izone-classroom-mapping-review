# Speaking Homework Lesson 15 — gói ứng viên

Thêm ba phần Tả người: Giới thiệu, Đặc điểm và Kết thúc, mỗi phần một lượt đầy đủ theo tài liệu nguồn. Giữ Bác sĩ AI khóa 67, hai bài bổ trợ khác nhau, lịch sử luyện và tự nộp của Lesson 11.

Nguồn: Google Docs `1alzzEIIeGvDMC0iDlZwj731y0Dxwtkeg_435cERKa7I`, tab `t.0`; ba chatbot đã đọc qua các link trong tài liệu ngày 26/10/2026. Chi tiết ngoại hình trong bài Đặc điểm là tùy chọn; thử thách chuyển đề cuối ba chatbot là bắt buộc theo đường tiêu chuẩn. Lời chatbot xác nhận toàn bài dùng cơ chế chung hiện hành.

## Nguồn và phát hành

- `speaking-person-checker.js`: bộ kiểm mới, dùng parser, snapshot 160.000 ký tự và recognizer chung.
- `speaking-checker.js`, `speaking-classroom-copies.js`: overlay của đúng API Speaking độc lập đã đọc, không build toàn main.
- `shared-speaking-classroom-copies.js`: chỉ thay ánh xạ Lesson 15 trong API Mapping chung; đích cài là `src/speaking-classroom-copies.js`.
- Migration canonical ở repo `izone-mapping-database`: `202610260915_speaking_lesson15_person.sql`.
- Registry canonical ở repo điều phối: thêm đúng mã `67-speaking-ta_nguoi`; hai workflow live chỉ thêm mã trong danh sách hỗ trợ, giữ graph/settings/trigger/credential.

Kiểm và backup riêng tư trên laptop: `E:/Codex-Data/speaking67-lesson15-20261026/`. Các kiểm trình duyệt dùng API giả; PostgreSQL trong RAM kiểm năm phần/receipt/Bác sĩ AI, không là bài học viên thật. Workflow thử `FJwh7qi4r12nE32e` inactive, execution `3014426` success với dữ liệu giả và không gọi dịch vụ ngoài.

Chưa chuyển production tại thời điểm tạo gói. Sau khi được phép: backup catalogue/ledger; overlay đúng image của hai API; giữ toàn bộ env/mount/network, worker tiến độ, phiên GV và cấu hình điểm danh; thêm template và hai registry; đọc lại API/URL/asset. Không sửa Docs nguồn, giao Classroom, nộp/chấm thay học viên hoặc gửi email thử.

Rollback bằng image/container và snapshot workflow trước phát hành, giữ tiến độ/receipt mới; không restore dump đè dữ liệu mới. Template có bài phát sinh chỉ đóng theo phạm vi được phép, không xóa lịch sử. Điểm danh Portal không có outcome mới vẫn phải báo chưa kiểm.
