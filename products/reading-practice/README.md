# Reading thực chiến khóa 67

Sản phẩm riêng cho bài luyện Reading. Buổi 7 giữ giao diện demo đã duyệt ngày 12/10/2026: 13 câu, 20 phút đang làm, Headings/MCQ/Summary, highlight/note, một phần Đáp án và giải thích với nút mở ngay dưới mỗi hàng.

## Phạm vi và nguồn

- Plan nghiệp vụ: `E:/Codex-Data/artifacts/reading-practice-buoi7-20261011/KE-HOACH.md`.
- Demo chốt: `E:/Codex-Data/artifacts/reading-practice-buoi7-demo-20261012/DEMO.html` và `unified-results-verification.json`.
- Giao diện Pages ở thư mục `reading-practice/` của repo Pages; chỉ có renderer và CSS/font đã ghim, không có đề/đáp án/lời giải hoặc học viên trong Git công khai.
- Nội dung nạp từ gói JSON riêng tư vào database; bản chuẩn không nằm trong source. Không tự mở bài cho lớp hoặc phát Homework hàng loạt.
- Source mới ở worktree từ backend `587cec77250cbb490236cc2524f8d0305f8732a5`, Pages `05a27ad544a9b77778a4c50d5ca65511947f9347`.

## Cách vận hành

Backend sở hữu danh tính theo bản Docs, lượt làm, giờ đã dùng, nháp, bài nộp và công việc ghi Docs. API ngữ cảnh K67 `/v1/snapshot` được dùng chỉ đọc theo hợp đồng v1; không truy cập bảng hoặc khởi động consumer của Term/Speaking. Các lớp có bài Reading được đăng ký riêng.

Chủ Docs được đối chiếu UUID → Google user/course qua cầu nguồn chỉ đọc v1, rồi so với đúng student submission và attachment Google Classroom. Đọc lại mã bài/tab trong Docs trước tạo binding. Nguồn mới chỉ có role/view riêng; chưa chạy migration hoặc thay runtime hiện hành trên VPS. Classroom có thể chưa sinh bản `STUDENT_COPY` khi submission còn `NEW`; phải chờ bản sao thật, không thay bằng template.

`npm ci`, `npm test`; `npm start` cần cấu hình riêng và database đã chuẩn bị. Công cụ preview chạy PGlite trên máy, không dùng kho production. Xem `DESIGN.md` và `ops/` trước phát hành; chưa có quyền production thì chỉ xây/kiểm cục bộ.

Chọn lớp/tên chỉ mở phiên đúng chủ bản Docs. Người có link kết quả vẫn phải đăng nhập Google và có quyền lớp. Điểm và lời giải do máy chủ trả sau nộp; reset không xóa kết quả cũ.
