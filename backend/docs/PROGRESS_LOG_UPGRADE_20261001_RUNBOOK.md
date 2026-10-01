# Registry và phát hành nâng cấp Progress Log

IC2305 (1294), 31 buổi. Migration `202610010001_progress_log_form_drafts.sql` đã áp production ngày 01/10/2026; API/demo/Pages đã chuyển và đọc lại. Các bước dưới giữ làm hợp đồng vận hành; lịch sử, hash, điểm khôi phục và phần còn chờ ở [bộ nhớ phát hành](PROGRESS_LOG_UPGRADE_20261001_PROJECT_MEMORY.md).

## Registry dữ liệu mới

| Nơi lưu | Trường | Ý nghĩa |
|---|---|---|
| learning.form_draft | id, create_operation_id, source_assignment_id | Nháp, mã tạo chống lặp và nguồn bản sao |
| learning.form_draft | owner_email, erp_course_class_id, session_number | Người soạn, lớp và buổi được phân quyền |
| learning.form_draft | public_definition, private_definition, content_hash | Nội dung, khóa chấm riêng và hash chung |
| learning.form_draft | revision, status | Revision tăng khi lưu; draft/pending_review/approved/published |
| learning.form_draft | approved_hash/revision/by_email/at | Khóa đúng nội dung đã duyệt; sửa xóa duyệt |
| learning.form_draft | published_assignment_id, publish_operation_id | Phiếu readback và mã chống lặp; published bất biến |
| learning.form_draft | created_at, updated_at | Timestamp có timezone |
| learning.form_draft_class_lock | erp_course_class_id | Một dòng khóa transaction của mỗi lớp cho mọi publisher |

Learning sở hữu cả hai bảng; không đổi schema ERP, active mapping hay ID học viên. learning_api SELECT/INSERT/UPDATE draft/lock, không DELETE draft; bổ sung SELECT reviewer class assignment và role/global flag để kiểm quyền. Trigger bảo vệ version/key published qua draft. Assignment ID bất biến, khóa lớp trước write; constraint deferred kiểm chỉ một phiếu active cùng buổi khi commit; replacement riêng được retire bản cũ trong transaction.

## API mới

Prefix `/api/learning`; mọi route teacher có auth/quyền lớp, draft có owner; key/review cần quyền đúng khóa, response private no-store.

| Route | Nhận → trả |
|---|---|
| GET /teacher/classes/:id/overview | Lớp → lịch/roster/matrix/counts/capturedAt/coverage |
| GET /teacher/classes/:id/sessions/:session/students/:ref | Người/buổi → bài/kết quả/nhận xét |
| GET /teacher/assignments/:id/question-analytics | Assignment → version/denominators/options/nhóm học viên |
| GET /teacher/form-drafts/types | Tám nhóm hiện hành |
| GET/POST /teacher/form-drafts | classId/list hoặc definition/key/session/operationId → owned draft |
| GET/PUT /teacher/form-drafts/:id | expectedRevision/nội dung → readback/replayed/409 |
| POST /teacher/form-drafts/copy | Source + target class/session/operationId → ID mới, giữ family |
| POST /teacher/form-drafts/:id/import-preview | text/revision → rows/errors/payload; chưa ghi |
| POST /teacher/form-drafts/:id/request-review | revision → chờ duyệt |
| GET /teacher/form-drafts/review-queue, GET /:id/review | Đúng course authority → danh sách/bản duyệt |
| POST /teacher/form-drafts/:id/approve | revision/hash → khóa duyệt |
| POST /teacher/form-drafts/:id/publish | revision/operationId → assignment/token/version/hash/roster/blocks/replayed |
| POST /teacher/form-drafts/:id/preview-grant | revision → grant năm phút, không key |
| POST /assignments/demo-source | Secret/grant → source pin revision/hash/quyền hiện hành |

Sai dạng/key/option lỗi trước ghi; stale/conflict trả 409 và nháp giữ nguyên. Quyền lớp không mặc nhiên cho tự duyệt câu có điểm; dùng course_content_authority active và kiểm lại khi publish.

## Phát hành và quay lui

1. Khóa image API/demo live, source hash và module nền; đóng overlay đủ import mới, giữ module khác. API đối chiếu 14 file không có lệch nghiệp vụ; `learning-demo.js` thuộc container demo riêng, không chép nó vào overlay API. Demo cần các module Learning mới và initializer Journey đang thiếu ở image cũ. Kiểm phiên 90 ngày và attendance consumer trên ứng viên, không build từ main local cũ.
2. PostgreSQL riêng nhiều connection: old/new publisher cùng buổi, same-operation retry, replacement new-before-retire, commit/rollback, không draft/assignment dở. PGlite chưa thay cổng này.
3. Sau quyền triển khai rõ: backup DB đã kiểm, snapshot config/image/container; apply migration bằng runner transaction/ledger. Readback table/constraints/triggers/GRANT, không in secret.
4. Chuyển API/demo cùng hợp đồng grant; health/startup/imports/log, lịch 31 buổi, draft/import/demo/publish lớp giả và kết quả người dùng nhìn thấy. Chỉ publish Pages khi API sẵn sàng.
5. So sự hiện diện/đích cấu hình điểm danh, consumer sync_portal_attendance, queue/outcome và revision guard trước/sau. Quan sát bài lớp thật hợp lệ tới Portal readback; chưa có ca mới giữ deployed_awaiting_validation.
6. Readback URL/assets/source hash, migration ledger, plan revision, assignment/version/roster/key hash theo mutation; không lưu token/key/bài học viên vào report công khai.

Rollback code/API/Pages về revision trước, tắt soạn/publish mới; giữ bảng/guard và bài/điểm/version/assignment đã nhận. Không DROP bảng, xóa bài hoặc sửa Portal. Schema mới tương thích luồng cũ và replacement có kiểm riêng. Bỏ trigger vì lỗi cụ thể phải qua migration mới được review/duyệt/backup/readback, không gỡ guard tùy tiện.

Trước hoàn tất: full backend/nhóm Pages/browser/checker cùng source cuối, RED/GREEN loading/date picker, review findings khép, public bundle không key/secret/PII, migration/idempotence/API role/rollback và PostgreSQL contention. Sau deploy còn cần quan sát Portal; job complete không thay bằng chứng đích.

## Cổng PostgreSQL riêng đã chuẩn bị

Chạy `scripts/check-progress-log-postgres-contention.mjs` bằng Node 24 đã ghim. Đầu vào là `PROGRESS_LOG_TEST_DATABASE_URL` được cấp qua môi trường riêng tư và `PROGRESS_LOG_TEST_DATABASE_CONFIRM=progress-log-upgrade-20261001`. URL phải trỏ localhost vào DB mới, trống, có tên bắt đầu `progress_log_upgrade_test_`; script từ chối đích khác trước ghi. Không đưa mật khẩu vào command line hoặc tài liệu.

Script tạo fixture giả, mở nhiều connection thật, chứng minh connection thứ hai đợi khóa, kiểm conflict khi commit, retry cùng operation, publisher cũ/mới, replacement, chặn đổi ID và rollback lỗi giữa publish. Kết quả là JSON tên ca/UTC; lỗi trả mã 1, giữ database test để điều tra. Script không DROP, không gọi ERP/Portal. Cần quyền tạo role/bảng trong môi trường riêng. Cổng PostgreSQL16 riêng VPS đã đạt6/6 ngày01/10; chạy lại phải dùng DB mới/trống, không chạy lại trên DB fixture đã có dữ liệu.

## Kết quả ứng viên local

Backend 303/303; nhóm Pages 38/38; callback học viên thực chạy Chrome 2/2; Chrome → API → DB 1/1. Hai lỗi loading/ô nhập ngày có RED trên base, GREEN cùng test trên head. PostgreSQL/backup/restore/migration/rollback/image đã đạt; Pages thật kiểm Journey31buổi và spinner đạt. G03 chưa đạt toàn bộ vì chưa có Portal readback của bài nộp sau chuyển và phiên giảng viên thật chưa kiểm; không gọi toàn gói verified. Hash và bằng chứng ở `PROGRESS_LOG_UPGRADE_20261001_QUALITY_GATE.json`.
