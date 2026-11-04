# Bản thử Speaking 67 xác nhận một lần

Trang Speaking dùng entrypoint hiện hành. Backend Speaking độc lập trả cấu hình xác nhận cho Doc trong danh sách thử. Khi xác nhận, backend kiểm mã màn ngắn hạn, dùng migration `202611040339_speaking_self_match.sql` để ghi quyết định và đọc lại binding của bài. Hai repository giữ cùng byte SQL để test và ứng viên phát hành dùng một hợp đồng.

## Cấu hình bản thử

- `SPEAKING_SELF_MATCH_ENABLED=true` cùng `SPEAKING_SELF_MATCH_DOCUMENT_IDS` và `SPEAKING_SELF_MATCH_STUDENT_REFS`. Hai danh sách dùng dấu phẩy, tối đa 100 mục mỗi danh sách. Chốt bằng nguồn lớp và Doc đã đối soát. Mặc định tắt.
- `SPEAKING_SELF_MATCH_MAIL_ENABLED=true`, `SPEAKING_SELF_MATCH_MAIL_TO`, `SPEAKING_SELF_MATCH_MAIL_FROM` và `SPEAKING_SELF_MATCH_MAIL_CREDENTIAL_FILE`. Credential riêng của tuyến gửi thư chứa `clientId`, `clientSecret`, `refreshToken`. Chỉ đặt ở runtime được cấp quyền gửi và dùng scope `gmail.send`. Mặc định sender tắt.
- Tra ca email theo `speaking_independent.self_match_notice.id`. Cột `sent_at` và `message_id` là xác nhận nhà cung cấp nhận yêu cầu. `attempts`, `available_at` và `last_error` cho biết còn chờ hoặc cần xử lý. Sau 8 lần thất bại, bản ghi giữ lại để đối soát. Nếu nhà cung cấp nhận thư nhưng mất phản hồi, lần gửi lại có thể trùng mã ca.
- Tra audit theo `speaking_independent.self_match_decision.id`. Trường `previous`, `current`, `source_key` và `student_ref` cho biết cặp liên kết và nguồn quyết định.

## Kiểm cách ly

Chạy `node --test test/speaking-self-match.test.js` trong backend. Đặt `SPEAKING_SELF_MATCH_PAGES` tới worktree Pages và `PLAYWRIGHT_MODULE` tới thư viện Playwright để chạy qua trang Lesson 6 thật với API cục bộ. Đặt `SPEAKING_EVIDENCE_DIR` tới thư mục riêng để nhận ảnh và mẫu thư giả. Các ca chạy với PGlite, fixture Docs và địa chỉ `.invalid` cho transport kiểm thử. Thư gửi thử thật, nếu được thực hiện, cần biên nhận riêng theo tài khoản gửi/nhận thực tế.

## Trước production

Đối chiếu image và overlay đang chạy với base của gói thử, backup đúng bảng bị tác động, kiểm danh sách Doc/hồ sơ, role migration và credential mail của runtime. Khi cần dừng, tắt hai công tắc riêng rồi quay lại artifact đúng baseline nếu cần. Giữ audit và hàng chờ để truy ca đã ghi. Tài liệu này mô tả bản ứng viên.
