# Phát hành và vận hành Listening buổi 8

## Audio mặc định cho bài mới · 27/11/2026

Bài Listening thực chiến mới dùng Cloudflare R2 trực tiếp, có GitHub Pages dự phòng cùng byte. VPS kiểm quyền và cấp link GET ngắn hạn. Chỉ đưa MP3 đã được phép làm nguồn Pages lên repo public. Giữ đề, đáp án, transcript, khóa và dữ liệu học viên trong nguồn riêng.

1. Dùng `node tools/register-r2-audio.mjs <asset-id> <local-mp3> <native-content-sha256>` để đăng ký theo đúng hash của bản nội dung. Tệp tên `<ten>-<16-ky-tu-dau-cua-sha>.mp3`. Lệnh tạo một mục chung chứa hash từng khối R2 và Pages. Frontend Listening nhận thông tin này từ API đã kiểm quyền.
2. Đưa tệp vào bucket private theo object key trả về và phát bản cùng byte tại URL dự phòng trả về. Đọc lại toàn tệp ở cả hai nguồn, xác minh SHA-256. Kiểm request Range của R2 và cấu hình CORS từ origin Pages.
3. Phát danh mục backend cùng bản nội dung. Runtime practice dùng `assets: ["*"]` để bật R2 cho các tệp đã đăng ký. Tạo một lượt thử, kiểm quyền, tải tiếp sau gián đoạn và tải Pages khi chặn R2. Công cụ seed mặc định kiểm tệp đã đăng ký. `--legacy-audio` dành cho khôi phục lịch sử hoặc ngoại lệ đã chỉ rõ.
4. Khi chuyển một bài cũ, dùng danh sách `adoptExistingAssets` theo đúng hash nếu cần đổi nguồn của lượt đã tạo. Quyền nghe và bản nháp của lượt giữ nguyên. Tab cũ dùng bản Pages cùng tệp. Khi cần quay lui, đổi cấu hình/chuyển lại bản runtime đã ghi và giữ dữ liệu học viên.


## Tự gắn CTA Classroom — 16/10/2026

`POST /api/admin/register-cta` dùng credential riêng `X-Listening-Admin`, nhận một event `course67_cta_registration_v1/v2` có Doc, submission, course, coursework, Google user và tên lớp. API tự đọc Docs, nhận đúng CTA/mã ngay dưới trong cùng tab; tài liệu không có Listening trả `not_applicable`. Thiếu/trùng/sai mã dừng trước ghi. Không nhận một batch nhiều học viên trong một request.

Nguồn quyền Listening có tuyến chỉ đọc `/v1/owner-by-classroom`, tra cặp course/Google user qua view đã cấp sẵn; không cấp thêm quyền mapping_db hoặc đổi view. Sau đó API vẫn kiểm roster UUID đã duyệt và verifier Classroom hiện có. Link mới được sinh ổn định; khi chạy lại hoặc đổi khóa vận hành, dùng lại token trong job CTA đã lưu, không tạo binding/job/link mới. Ghi qua hàng Docs hiện có, chỉ trả `verified` sau đọc lại hyperlink; chờ quá hạn trả `CTA_PENDING` để thử lại cùng identity. Có thể phục hồi link bị xóa bằng cùng job, giữ bài làm và link cũ.

Workflow `f9JNQ9Vui36U8Tz5` giữ nguyên các node Reading/Listening chấm cũ. Sau đường xử lý cũ hoặc bỏ qua event trùng, nó kiểm thêm CTA Listening; sự kiện chạy bù có `listening_only=true` đi riêng để không chạm Reading/Speaking. Trigger nội bộ nhận đúng một Doc, caller dùng một execution cho từng học viên. Không chỉ dùng status parent để nghiệm thu; đối chiếu `documentId/status`, binding/job và Docs đích.

Để mở bài, chờ mọi binding CTA verified rồi dùng tuyến admin/assignment hiện có; không tự đổi lớp/source của bài đã đăng ký. Chạy bù IC2304 Lesson 8 giới hạn course 826336470852, coursework 874003464332 và 15 Doc từ Classroom. Trước/sau giữ snapshot nội dung và link Reading/Speaking; chạy lại phải giữ nguyên revision, URL, binding/job ID và không có work mới.

## Ghi nhớ đăng nhập giảng viên

Cookie riêng listening_teacher phải có Path=/listening-practice-api/api, HttpOnly/Secure/SameSite=None/Partitioned trên HTTPS. Ghi nhớ mặc định: gia hạn 90 ngày sau khi kiểm quyền lớp thành công, trần 365 ngày từ đăng nhập; bỏ ghi nhớ dùng phiên cookie một giờ. Giữ Bearer còn hạn để chuyển tab cũ sang cookie. Cả kết quả và audio xem lại dùng cùng bộ kiểm phiên.

Trước chuyển runtime, backup DB/nguồn/cấu hình và chạy db/003-teacher-session.sql bằng owner của DB Listening. Migration bổ sung absolute_expires_at, remembered; giữ hạn phiên cũ và chạy lại an toàn. Có default một giờ để rollback runtime cũ vẫn ghi được phiên. Không đụng bảng bài làm hoặc schema sản phẩm khác. Đăng xuất yêu cầu Origin hợp lệ và X-Izone-Csrf: 1, thu hồi phiên trên máy chủ; frontend xóa cache/audio và thông báo các tab giảng viên khác.

Kiểm thêm test/teacher-session.test.js và tools/teacher-session-browser-check.mjs ở chế độ cross-site/cross-site-mobile, dùng hai miền HTTPS trỏ local và Google fixture. Không coi đó là kiểm tài khoản Google thật. Sau production đọc lại hai cột bằng role ứng dụng, cookie/CORS/logout và runtime consumer. Rollback giữ các cột bổ sung, không restore dump đè bài làm mới.

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
