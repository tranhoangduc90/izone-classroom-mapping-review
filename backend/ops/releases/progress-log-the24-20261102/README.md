# Progress Log Thẻ 24 — nháp nhận xét theo tài khoản

Chưa phát hành production. Migration mới: `202611020001_teacher_comment_drafts.sql`, kế thừa bảng nhận xét/lịch đã có.

## Hợp đồng

- GET `/api/learning/teacher/session-comments/editor`: classId, studentRef, sessionNumber; trả public comment và draft của tài khoản được xác thực.
- PUT `.../draft`: noteText, expectedRevision (bản công khai), expectedDraftRevision, operationId và đúng lớp/người/buổi.
- POST `.../send`: cùng dữ liệu; có thể gửi khi chưa có nháp. Gửi, audit và chuyển nháp người gửi thành tombstone trong một transaction. Trả draftRevision mới; giữ nháp tài khoản khác.
- POST `.../delete`: expectedRevision của bản công khai và operationId; ẩn bản hiện hành, giữ nội dung audit và mọi nháp. Không dùng chuỗi rỗng để xóa.
- Actor luôn từ phiên giảng viên; schema strict, no-store, quyền lớp/người và kế hoạch được kiểm trên máy chủ. Không cấp API nháp cho học viên. Giới hạn 1–1.000 Unicode code point, không NUL.
- Revision và operation ID bảo vệ ghi đồng thời/retry. Hai thiết bị lệch bản nhận 409 COMMENT_STALE/COMMENT_DRAFT_STALE; không ghi đè âm thầm. Tombstone ngăn client cũ ghi lại revision 0 sau khi gửi.
- Các route PUT session-comments, POST hide/history và chữ ký thao tác cũ giữ tương thích. Không đổi bảng bài làm, điểm, điểm danh, hàng Portal hoặc Term Test.

## Kiểm và triển khai

Service/API dùng PGlite; PostgreSQL 16 dùng role learning_api và nhiều connection, kiểm 20 lần lưu/gửi/retry, cạnh tranh save/send, quyền cột, rollback và audit. Chrome tích hợp nằm ở `test/learning-the24.browser.mjs`; `PAGES_SOURCE_ROOT` chỉ tới worktree Pages tương ứng. Tất cả dữ liệu là fixture, không nối DB production.

Phát hành sau câu duyệt cụ thể: sao lưu và đọc lại backup; kiểm image/source/config hiện hành chưa drift; áp migration trong transaction; canary quyền API và GET editor; đưa API lên trước giao diện. Chỉ overlay `src/learning-journey-comments.js` và `src/learning-routes.js` lên image đang dùng, giữ source ngoài gói, mount/network/config và cookie đăng nhập chung. Kiểm scope bằng toàn bộ hash source trước/sau và canary đăng nhập/khôi phục/đăng xuất. Runtime demo không cần đổi vì hợp đồng học viên giữ nguyên.

Sau phát hành đọc lại giao diện thật và dữ liệu cũ, không giao/nộp bài cho lớp thật. Rollback code dùng image/container trước phát hành, giữ hai bảng mới/audit và mọi dữ liệu hợp lệ phát sinh. Không drop bảng hoặc restore dump cũ lên dữ liệu mới.
