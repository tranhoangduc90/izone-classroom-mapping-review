# Tiến độ thực hiện nâng cấp Progress Log

Kế hoạch gốc: `E:/Codex-Data/progress-log-plans/2026-09-30/PLAN.md`, revision 1; đủ 5 lát và 29 mã nghiệm thu. Task vẫn đang thực hiện, chưa phát hành. Lớp pilot là IC2305, ERP 1294; việc mở nhầm IC2304 không thay yêu cầu.

## Phạm vi và trạng thái

- Lát 1 đã xây loading/hủy/retry/back Journey, một ô ERP, auto-read/refresh, proposal, fingerprint/revision, cache phần chỉnh và diff xung đột. Chrome Portal IC2305 đối chiếu đủ 31 ngày/header; status 1 là Đã diễn ra, 0 là Đã lên lịch ở lớp pilot. Không suy số thứ tự chính thức cho mọi lớp từ index thô; giảng viên vẫn xác nhận. Còn readback khi phát hành.
- Lát 2 đã xây API/tab Hành trình lớp, matrix/mobile/filter/detail, lớp chưa có assignment, roster hiện hành/lịch sử và nguồn Test tổng hợp. Writing pending/ready và active/dropped/on_hold được kiểm bằng DB giả. Aggregate không gọi Journey theo từng người.
- Lát 3 đã xây phân tích từng câu, một bài hiện hành mỗi học viên, lần chấm hoàn tất, mẫu số/pending/manual/hidden/optional; retake/regrade/retry đã kiểm. Tự khai/câu mở chưa thành điểm khách quan.
- Lát 4 đã xây bộ soạn tám nhóm, tạo/copy/reorder/delete, điều hướng phần, ô phụ theo phương án, nháp server/revision/conflict, nhập preview/confirm, demo riêng. Lát 5 đã xây duyệt/hash/course, publish atomic/idempotent, khóa chung publisher cũ/mới, immutable và readback/link fragment. Không gọi API/Firebase Đức Anh; không thêm luyện tập ngoài Journey.

## Thiết kế nháp và phát hành đã xây

Nháp có owner, lớp/buổi, definition công khai, grading key riêng, revision và hash tổng nội dung. Lưu nháp phải so expected revision; mọi sửa đổi xóa trạng thái duyệt. API giảng viên kiểm quyền lớp; key chỉ trả owner/người duyệt đúng khóa. Trình duyệt giữ nội dung đang soạn trong RAM, không lưu key ở localStorage.

Nhập CSV/văn bản có xem trước và xác nhận; dòng lỗi không bị bỏ âm thầm. Import chỉ cập nhật nháp. Danh mục backend/UI giới hạn 8 nhóm đã dùng; grader chỉ none/exact_option. Gapfill sao chép chuyển cấu hình hardcoded thành sentenceLines và remap ID/điều kiện.

Duyệt khóa revision/hash và quyền course_content_authority, kiểm lại quyền lúc publish. Publish khóa nháp và dòng lớp trong transaction, kiểm operation key, trùng phiếu, tạo version/key/assignment/roster/releases, đọc lại trước commit. Trigger chung bảo vệ publisher cũ/mới; constraint deferred cho luồng replacement có kiểm riêng tạo mới rồi retire bản cũ cùng transaction. Không thêm luồng sửa lịch sử. Copy giữ item family nguồn và remap version/control ID.

Preview nháp ký grant sống 5 phút; demo đọc definition/key qua cổng dịch vụ có secret và kiểm revision/hash. Source đọc lại account/quyền hiện hành, không tin quyền cũ trong grant. Kho demo tạo roster giả; không tạo phiếu tạm trên lớp thật. Source payload được pin cho reset; không đổi dữ liệu nguồn thật.

## Vận hành

Thiết kế vận hành theo mục 11: pilot 18 × 31 ô; fixture tải 20 × 31. Overview bốn query, analytics ba query, nguồn Test một round trip DB. Journey deadline 15 giây; ERP toàn tuyến 18 giây, UI chờ 20 giây; draft mutation 25 giây. Gộp request ERP cùng lớp đang bay, mỗi refresh đọc mới. Không thêm AI/dependency. Lỗi tổng hợp không chặn nộp; ERP lỗi giữ phần chỉnh; publish lỗi rollback/giữ nháp. Điểm danh chỉ do nộp đủ Progress Log hoặc override hiện hành.

Log progress_log_operation giữ route mẫu, status, duration, correlation và UTC; không giữ body/query/email/key/token. Logger lỗi không đổi outcome. Quan sát ERP chậm/lỗi, 409 plan/draft/publish, aggregate latency, readback roster/hash và Portal outcome.

Quay lui: rollback Pages/API về revision trước, giữ cấu hình và consumer điểm danh. Không xóa bài, điểm, version hoặc nháp; khi draft/publish chưa đạt, giữ chức năng đó chưa phát hành. Migration mới phải kiểm trên fixture, thử rollback và có quyền apply riêng trước production.

## Bằng chứng hiện có

- Backend cuối: 303/303, không fail/skip; chạy `npm run check` rồi full suite với file concurrency 2. Baseline 280/280 chỉ là mốc trước thay đổi.
- Pages toàn bộ nhóm local: 38/38, không fail/skip. Hai callback ghi nhớ học viên/phiếu buổi 3 đã thực chạy trên Chrome: 2/2; không tính parse callback bằng Node là kiểm hành vi.
- J01 và E01 cùng test có RED trên Git baseline (2 lỗi đúng nội dung người dùng phản ánh), GREEN trong full Pages cuối; không tính thiếu helper mới là bằng chứng RED.
- Browser mới: E01/E02/O01/O04 trên 390/768/1440 px đạt; screenshots đã đọc trực quan. Mạng ngoài/API thật bị chặn hoàn toàn.
- PGlite: ca lớp zero assignment + bulk Test + Writing cập nhật muộn + dropped/on_hold đạt. Ca demo detail và quiz 40 câu đạt ở lượt riêng.
- Hai lỗi mới đã được phát hiện/sửa: tên cột score_earned; canonical hóa sessionDates trước readback để thứ tự JSON key không gây lỗi giả. Không thay test để chấp nhận kết quả sai.

## Kiểm bổ sung và cổng còn lại

- Review độc lập GPT-6.1 Sol/high đã khép các lỗi: publisher cũ chưa dùng khóa chung, mất phần gõ khi lưu chậm, grant giữ quyền cũ, copy mất family, ô buổi chưa readonly sau publish, đổi assignment ID né deferred guard. Guard cuối cấm đổi ID; test INSERT duplicate → đổi ID → rollback vẫn còn một active. Replacement new-before-retire vẫn đạt.
- Chrome → API → DB cuối đạt 1/1: đủ tám dạng, copy/save sáu phiếu 57 câu/14 ô, dữ liệu giả không outbox mới; từ thống kê câu sai mở đúng bài/học viên/buổi. Chrome Journey kiểm deadline 15 giây thật, retry/back/mobile và không tạo attempt/submission.
- Fixture 20 người nộp/retry, readback 20 submission/attendance/Portal job; 620 ô Overview. p95 lượt riêng 64 ms/16 ms, có EXPLAIN ANALYZE BUFFERS; không thay SLA production.
- PGlite serialize transaction: race test request không thay contention PostgreSQL nhiều connection. Docker/psql local không có trong PATH ở lần kiểm; không tự cài hoặc ghi test vào production.
- Script PostgreSQL thật đã chuẩn bị: `scripts/check-progress-log-postgres-contention.mjs`, đã kiểm cú pháp, chưa thực thi nghiệp vụ. Chỉ nhận DB riêng trên localhost, tên test và xác nhận đúng task; phải trống, không DROP DB. Kiểm connection riêng/wait lock, old/new publisher, retry, replacement/ID guard và rollback.
- Đối chiếu chỉ đọc API live `izone-speaking-course67:20260930-v2`: 14 file source API thuộc gói khớp base hoặc file mới chưa tồn tại; cấu hình điểm danh hiện diện và worker còn ở image. Demo riêng `izone-progress-log-demo:20260929.1`; source chỉ thiếu initializer Journey so với base, không có thay đổi nghiệp vụ mới ngoài base. Không áp overlay demo vào API.
- Các lượt OOM/timeout cũ giữ trạng thái failed/cancelled. Lượt gom cả live smoke thất bại vì thiếu `LIVE_PROGRESS_LOG_URL`; đây là script kiểm production riêng, chưa được coi là đã đạt. Full local không thay kiểm URL thật sau phát hành.
- Tool graph được AGENTS Pages yêu cầu chưa có trong inventory tool; không tuyên bố đã cập nhật graph.

Source/test/schema cuối đã khóa bằng hash trong manifest; backend/Pages/browser/integration cùng revision. Checker không có lỗi schema, trả `pending/not_ready`: còn P02/PG01 PostgreSQL thật, G02 backup/staging/rollback/image và G03 phát hành/readback/Portal. 28/29 mã kế hoạch có bằng chứng local; P02 mới có race giả và chưa chốt. Giữ toàn bộ phạm vi, chưa merge/push/migration/deploy. Registry và hợp đồng phát hành: [runbook](PROGRESS_LOG_UPGRADE_20261001_RUNBOOK.md).
