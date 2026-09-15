# Progress Log production — 2026-09-15

## Kết quả người dùng nhìn thấy

- Học viên mở một link lớp, chọn tên, làm từng phần khi giảng viên mở và chỉ được điểm danh sau khi nộp đủ trường bắt buộc.
- Giảng viên có thể mở/khóa từng block, xem checkpoint, dashboard, tổng kết hệ thống và ghi lời nhắn người thật riêng.
- Giảng viên tạo link hành trình riêng cho từng học viên. Học viên thấy tóm tắt gần nhất trước; timeline từng buổi chỉ mở khi bấm xem.
- Dữ liệu học viên trên trang hành trình chỉ gồm báo cáo đã phát hành và evidence có quyền `student_visible`; không trả câu trả lời thô hoặc note nội bộ.

## Phiên bản đã phát hành

- Backend Git: `411206901c6056d01e680ce2186adac0968eac35`.
- GitHub Pages Git: `d01bbcb`.
- Backend image: `izone-term-test-backend:20260915.1-progress-log`.
- Image ID: `sha256:d826205511f7cd9ffa5d45b458432ca14d3a49d8a007ea89599133a27c80422e`.
- Health readback: `1.8.4-k67-progress-log`, deployment profile `k67`.

## Database

- Backup ngay trước migration: `20260915T091846Z`.
- PostgreSQL: `16.14`.
- Backup có marker `VERIFIED`; `pg_restore --list` và SHA-256 của dump/schema đều đạt.
- Ledger production đã áp dụng đủ `202609150001` đến `202609150004`.
- Migration V2 giữ các loại job Term Test đã tồn tại và khóa block bằng `assignment_id + block_id`; không giả định checkpoint là duy nhất.

## Readback sau phát hành

- Health API: 200.
- Mở phiếu demo: 200, roster 6 học viên giả, hai block đều `open`.
- Hành trình demo: 200, đúng class/student key, có báo cáo đã phát hành.
- Evidence phía học viên: đúng 1 nguồn `progress_form`; chuỗi evidence thô kiểm thử không xuất hiện trong response.
- GitHub Pages: trang phiếu, portal giảng viên và trang hành trình đều 200; Playwright không ghi nhận lỗi/warning console.
- Kiểm thử local: 94/94 backend, 6/6 frontend tĩnh, identity contract đạt.

## Link demo và hướng dẫn

- Phiếu học viên: `https://tranhoangduc90.github.io/izone-ai-team-pages/progress-log/#assignment=20000000-0000-4000-8000-000000000302`
- Portal giảng viên: `https://tranhoangduc90.github.io/izone-ai-team-pages/progress-log/teacher.html`
- Hành trình học viên: `https://tranhoangduc90.github.io/izone-ai-team-pages/progress-log/journey.html#access=demo-progress-567-00000000-0000-4000-8000-000000000003`
- Hướng dẫn chi tiết: repo Pages, `progress-log/HUONG_DAN_TRAI_NGHIEM.md`.

Toàn bộ dữ liệu trong lớp demo là giả. Không nhập dữ liệu học viên thật vào lớp này.

## Rollback

Nếu backend có lỗi, dựng lại riêng service `mapping-review-api` bằng chuỗi compose trước phát hành và image `izone-term-test-backend:20260914.3-k67`. Migration mới chỉ thêm bảng/cột và quyền; mã cũ vẫn chạy được. Không xóa schema để rollback ứng dụng.

## Chưa được coi là hoàn tất để mở rộng 110 lớp

- Chưa chạy load test staging 1.000/1.650 người theo SLO đã chốt.
- Chưa diễn tập restore backup trên staging cho bản này.
- Chưa pilot 4 lớp thật qua các mốc buổi 2, 5 và 10.
- Chưa nối AI provider và nguồn homework thật; báo cáo production hiện dùng dữ liệu demo đã seed.
