# Phát hành Reading buổi 7

Chưa chạy các bước dưới trên production. Gói riêng gồm hai API, một PostgreSQL riêng và một route Nginx. Không sửa runtime Term/Speaking/Progress Log; nguồn mapping chỉ thêm một role/view chỉ đọc. Không tự giao bài hàng loạt.

## Cấu hình và chuẩn bị

1. Tạo image từ revision đã duyệt; copy gói đề riêng tư tới thư mục không public. Nạp version `cam18-t3-p2-approved-20261012-v1` bằng `tools/seed-content.mjs`. Công cụ kiểm đúng database và role, không mở lớp.
2. Tạo file `.env`, `.owner.env`, `.secrets/db-owner-password` riêng tư trên VPS. Mật khẩu ngẫu nhiên tối thiểu 32 ký tự; admin key 43 ký tự. API Reading không nhận credential mapping_db. Nguồn owner nhận role `reading_owner_reader` chỉ đọc view mới.
3. Chuẩn bị PostgreSQL `reading-db`, database `reading_practice_db`, owner `reading_practice_owner`. Chạy `tools/bootstrap-database.mjs reading` với URL owner trong biến `READING_BOOTSTRAP_DATABASE_URL` và mật khẩu app trong file được trỏ bởi `READING_NEW_ROLE_PASSWORD_FILE`. Đây là role app không superuser, chỉ quyền dữ liệu trong schema Reading.
4. Sau backup schema/role của mapping_db, chạy cùng công cụ ở chế độ `owner-source`. View mới đối chiếu UUID, Google user, lớp/course đã approved và membership active. Role tồn tại thì công cụ dừng để bảo toàn cấu hình cũ.
5. OAuth cho Docs cần quyền đọc/ghi Google Docs và đọc student submissions Classroom. `READING_DOCS_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN` phải cùng ứng dụng OAuth đã cấp token. Tách khỏi `READING_GOOGLE_CLIENT_ID` là web client xác minh giảng viên. Xác minh tài khoản thật truy cập được bản sao và đúng lớp. Google web client cần origin GitHub Pages được đăng ký. Không lấy token giả của preview sang production.

## Bản sao và mở lớp

Producer hoặc người vận hành chuẩn bị một file JSON riêng tư cho mỗi bản sao, có `classId`, `classCode`, `studentRef`, `courseId`, `courseWorkId`, `submissionId`, `documentId`, `tabId`, `contentVersion`. UUID lấy từ mapping đã duyệt; Docs lấy từ đúng submission Classroom, không nối bằng tên/tên file. `tools/register-copy.mjs` sinh và lưu `entryToken` trước khi gửi để lần retry giữ nguyên link.

Đặt `READING_ADMIN_API` bằng endpoint API và `READING_ADMIN_KEY` trong môi trường riêng, chạy `node tools/register-copy.mjs <file-rieng-tu.json>`. Kết quả link được lưu trong file riêng tư; terminal chỉ báo ID và CTA đang chờ đọc lại. API tự kiểm lại chủ sở hữu, mã bài và tab trước đăng ký. Lỗi thì không tạo binding. Nếu Classroom chưa sinh bản Docs (`NEW`), chờ bản sao xuất hiện rồi đăng ký; không gắn link template hoặc bản người khác thay thế.

`node tools/operate.mjs status` xem số CTA đã đọc lại, job chờ/lỗi. `open <assignmentId>` chỉ mở khi mọi binding có owner proof thật và CTA đã verified; `close <assignmentId>` chặn lượt mới/reset nhưng giữ quyền tiếp tục bài dở và kết quả. `retry <jobId>` chỉ gửi lại job đã blocked, giữ thứ tự. Lỗi chỉnh tay phải kiểm đúng ô trước retry; không ghi đè sửa tay để làm job xanh.

Sau bước runtime canary và quyền Google đạt mới mở lớp pilot do Đức chọn. Phát hành Pages chỉ thư mục `reading-practice/`; không publish gói câu hỏi/đáp án/lời giải, dữ liệu học viên hoặc file private.

## Đối chiếu và quay lui

VPS đọc ngày 12/10: cổng 8808/8809 chưa có listener; nguồn context ở `term-mini-k67-context-source:8797`, mạng `n8n-net`. PostgreSQL mapping cũng vào `n8n-net`. Compose Reading có database/volume/mạng nội bộ riêng; chỉ cầu nguồn/API dùng mạng context để gọi nguồn chỉ đọc và Google. Cổng nguồn owner không xuất ra Internet.

Thêm snippet `nginx-reading.conf` vào server HTTPS, backup trước rồi `nginx -t`; reload chỉ sau duyệt. Smoke health → source permission → đăng ký canary → CTA readback → login → start → reload/offline/reset → submit → Docs text/link → teacher Google/class access. Kiểm native PostgreSQL khóa hai request và tải 30 người trước mở pilot.

Quay lui: đóng assignment, bỏ route Reading hoặc trở lại image Reading đã ghim. Giữ database/volume và bài nộp mới; không restore dump cũ đè bài học viên. Không restart hay thay env container của sản phẩm cũ. Role/view nguồn mới có thể giữ ở trạng thái chỉ đọc để bảo toàn bằng chứng; việc xóa cần quyền riêng.
