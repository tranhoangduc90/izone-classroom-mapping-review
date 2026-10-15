# Phát hành và vận hành Listening buổi 8

## Cửa sổ giải thích và nghe lại — 15/10/2026

File `private/review.json` chứa transcript và mốc Q21–Q30, không đưa vào Git hoặc Pages. Cấu hình `LISTENING_REVIEW_FILE=/private/review.json` và bind file chỉ đọc theo compose. Kiểm SHA audio và contentVersion với nội dung đang dùng. Loader dừng khởi động nếu mốc/file không hợp lệ; kết quả khác phiên bản không nhận gói nghe lại. Nội dung và đáp án bài không đổi.

`result/:attemptId` và `teacher/result/:submissionId` chỉ bổ sung gói xem lại sau kiểm quyền cũ. Audio xem lại có hai tuyến cùng tên `review-audio`, một cho chủ bài đã nộp, một cho GV có quyền lớp. Không dùng tuyến audio làm bài để mở lại audio sau nộp. URL trả về là tương đối với API base để hoạt động dưới prefix Nginx.

Trước cập nhật: lưu image ID, cấu hình container, .env/compose và backup DB Listening trong kho riêng tư; so consumer Reading/Term Test. Build image theo commit đã kiểm. Chạy `tools/review-check.mjs` trong DB mới có tên `listening_practice_canary_review_*`, không chạy trong DB production. Công cụ đọc `/private/content.json`, audio và review; dùng danh tính giả và không chạy worker Docs.

Triển khai chỉ `docker compose up -d --no-deps --no-build listening-practice` với image đã build và file review đã kiểm. Không dựng lại DB, owner-source, Reading hoặc Term Test. Đọc health, kiểm hai tuyến audio không phiên trả 401, so hash file mới và trạng thái consumer. Frontend lên sau backend. Đây là phát hành sản phẩm; không tự đăng ký/mở bài cho lớp.

Rollback: phục hồi .env/compose trước phát hành, ghim image cũ và cập nhật riêng listening-practice; giữ nguyên DB/audio. Không restore DB đè bài làm mới chỉ để quay lại giao diện. Frontend có thể revert commit riêng trong repository Pages.

Đích /opt/listening-practice67, Compose project listening-practice67; container API izone-listening-practice67, DB izone-listening-practice67-db và nguồn quyền izone-listening-owner-source. API nội bộ 8818, nguồn quyền 8819. Route HTTPS /listening-practice-api/; frontend /izone-ai-team-pages/listening-practice/.

Tạo .env và .owner.env riêng từ .env.example, dùng LISTENING_*; LISTENING_AUDIO_FILE=/private/audio.mp3. Audio và content.json đặt trong private, kiểm SHA audio so với nội dung trước mở lớp. Content version cam19-t3-p3-approved-20261014-v1, 10 câu, tổng 579207 ms. Chỉ seed qua tools/seed-content.mjs; không đặt key/audio trên Pages.

Bootstrap DB ứng dụng và role/view nguồn đọc bằng tools/bootstrap-database.mjs sau backup schema và role mapping_db. Đơn vị phát hành riêng; ghim image theo commit/digest đã kiểm. Snippet ops/nginx-reading.conf là route Listening (tên file kế thừa), kiểm nginx -t trước reload. Không restart consumer khác.

Mở lớp là bước riêng: đăng ký đúng tài liệu/tab/mã 67-practice-listening_mcq_flowchart, CTA “NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP LISTENING”, kiểm ghi/đọc lại CTA rồi mở đúng assignment. Đợt phát hành này chưa đăng ký học viên hoặc phát link Classroom.

Kiểm /api/health, truy cập audio không phiên phải 401, xem hàng doc_job blocked/pending và readback tài liệu khi có bài thật. Không in .env/credential ra log. Canary dùng DB listening_practice_canary_* riêng và tài liệu sao chép riêng.

Quay lại: ghim lại image đã ghi trong biên bản phát hành rồi chỉ cập nhật hai dịch vụ Listening. Trước mở lớp có thể dừng riêng chúng và gỡ include Nginx Listening bằng bản backup đã kiểm; giữ DB/audio/bằng chứng để phục hồi. Không xóa dữ liệu hoặc role nguồn, không phục hồi toàn mapping_db đè hoạt động khác.
