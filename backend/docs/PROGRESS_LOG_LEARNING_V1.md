# Progress Log Learning V1 — Hướng dẫn bàn giao

## 1. Người dùng sẽ thấy gì

Học viên mở một link, chọn tên, xác nhận đúng người, điền 2–3 lần ghi ngắn theo thời điểm giảng viên quyết định rồi bấm **Nộp phiếu & điểm danh**. Chỉ khi máy chủ nhận đủ trường bắt buộc, màn hình mới xác nhận điểm danh.

Giảng viên đăng nhập Google, chọn lớp, chọn 2–3 câu từ thư viện và tạo link. Dashboard chỉ ưu tiên ba nhóm: đã nộp đủ, nộp thiếu và chưa nộp. Mọi điều chỉnh điểm danh phải có lý do.

AI không nằm trên đường nộp bài. Sau khi bài, điểm danh và evidence đã được lưu, một job mới được xếp hàng để phân tích. Vì vậy AI hoặc n8n lỗi không thể làm mất bài hay tước điểm danh.

## 2. Phần đã hiện thực trong mã nguồn

- `FormDefinitionV1`, `FormGradingKeyV1`, `SubmissionReceiptV1`, `QuizResultV1` và `EvidenceEnvelopeV1` có JSON Schema bằng Zod.
- Engine chấm hỗ trợ text, single choice, Matching, TRUE/FALSE/NOT GIVEN, YES/NO/NOT GIVEN, chọn TWO/THREE không xét thứ tự và Writing chấm bất đồng bộ.
- Schema PostgreSQL `learning` tách public definition khỏi grading key, giữ version form/submission/grading/evidence/report.
- API reflection: mở phiếu, xác nhận tên, autosave có revision, submit idempotent, receipt, dashboard và override điểm danh có audit.
- Adapter Term Test bỏ đáp án chuẩn trước khi tạo evidence; homework/note có thể dùng chung external envelope.
- Outbox có lease, retry/backoff và đối chiếu đủ `entity_key`, `unit_key`, `operation_key`, `idempotency_key` trước khi nhận output.
- Giao diện học viên và giảng viên không dùng HTML tự do; token phiếu nằm sau dấu `#`, không nằm trong query của GitHub Pages.
- Bộ kiểm thử unit, database, API boundary, static security và load-test harness.

Chưa thực hiện: migration production, kết nối provider AI, đồng bộ nguồn homework thực, chạy load test staging 1.650 người và phát hành GitHub Pages. Những bước này cần hạ tầng/backup/staging và phê duyệt riêng.

## 3. Vị trí thành phần

| Thành phần | Vị trí |
|---|---|
| Contract | `src/learning-contracts.js` |
| Chấm bài và dựng evidence form | `src/learning-domain.js` |
| Adapter Term Test/nguồn ngoài | `src/learning-evidence-adapters.js` |
| SQL nghiệp vụ | `src/learning-sql.js` |
| Service và API | `src/learning-service.js`, `src/learning-routes.js` |
| Queue có kiểm identity | `src/learning-outbox.js` |
| Migration riêng | `ops/learning-migrations/202608290001_learning_platform_v1.sql` |
| Test tải staging | `scripts/learning-load-benchmark.mjs` |
| Contract lineage | `../workflows/progress-log-identity-contract.json` |
| Giao diện tĩnh | repo `izone-ai-team-pages/progress-log/` |

## 4. Cấu hình backend

Backend nhận bốn biến cấu hình. `LEARNING_DATABASE_URL` phải trỏ tới login riêng được cấp role `learning_api`; mật khẩu nằm trong secret store của host, không ghi vào `.env` trong Git.

Đoạn dưới là ví dụ tên biến, không chứa credential thật. Backend đọc chúng khi khởi động; nếu bật tính năng nhưng thiếu database URL thì sẽ dừng rõ ràng thay vì chạy nửa vời.

```dotenv
LEARNING_ENABLED=true
LEARNING_DATABASE_URL=postgresql://<learning-login>:<secret-from-store>@<host>/<database>
LEARNING_DB_POOL_MAX=20
```

IT cần tạo một login PostgreSQL riêng rồi grant role `learning_api` cho login đó. Migration chỉ tạo role quyền `NOLOGIN`, không tạo hoặc lưu mật khẩu.

## 5. Kiểm thử local

Lệnh dưới kiểm cú pháp các module mới. Nó chỉ đọc file JavaScript và báo lỗi vị trí; không kết nối production và không ghi dữ liệu.

```powershell
node --check src/learning-contracts.js
node --check src/learning-domain.js
node --check src/learning-evidence-adapters.js
node --check src/learning-outbox.js
node --check src/learning-service.js
node --check src/learning-routes.js
```

Lệnh tiếp theo chạy test bằng dữ liệu giả và PostgreSQL nhúng. Test tạo database tạm trong bộ nhớ, thử publish, autosave, submit lặp, hai học viên trùng tên, chấm Term Test và kiểm answer key không rò ra public output. Khi lỗi, Node in tên ca test; không thay đổi database thật.

```powershell
node --test test/learning-*.test.js
```

Giao diện có bộ test tĩnh riêng. Lệnh này kiểm CSP, URL fragment, không dùng `innerHTML`, không có credential và override điểm danh bắt buộc lý do.

```powershell
node --test tests/progress-log-static.mjs
```

## 6. Quy trình migration staging

Migration Progress Log đã được tách khỏi thư mục migration mapping mặc định. Điều này ngăn công cụ cũ vô tình đưa schema mới lên production.

Trước hết, IT dùng runner hiện hành với `--migration-dir` trỏ rõ thư mục Progress Log và target staging. Chế độ `--plan` chỉ so checksum/ledger và liệt kê việc chờ chạy; không sửa schema.

```powershell
node scripts/mapping-db-migrate.mjs --plan --target <staging-ssh-target> --migration-dir ops/learning-migrations
```

Chỉ sau khi backup staging có marker `VERIFIED`, IT mới dùng `--apply`. Runner bọc mỗi migration trong transaction, dùng advisory lock, kiểm checksum và rollback khi lỗi.

```powershell
node scripts/mapping-db-migrate.mjs --apply --target <staging-ssh-target> --migration-dir ops/learning-migrations --backup-id <YYYYMMDDTHHMMSSZ>
```

Không dùng lệnh apply với production trong lượt triển khai hiện tại. Trước production phải readback PostgreSQL version/tài nguyên/backup, test restore staging, chạy load test và có phê duyệt riêng.

## 7. Load test 1.650 người trên staging

File manifest chỉ chứa public token của 110 assignment staging, không chứa tên hoặc ID học viên:

```json
{
  "assignmentTokens": [
    "<uuid-cua-phieu-staging-1>",
    "<uuid-cua-phieu-staging-2>"
  ]
}
```

Phase `open` là read-only: script mở form theo lịch năm phút, tổng hợp p50/p95/max và chỉ in mã lỗi, không in token/roster.

```powershell
node scripts/learning-load-benchmark.mjs --phase open --base-url https://<staging-host> --assignments-file <manifest.json> --virtual-users 1650 --duration-seconds 300 --concurrency 100
```

Phase `submit` tạo start/draft/submission và điểm danh trên **dữ liệu staging**. Vì có ghi dữ liệu, script bắt buộc `--confirm-write` khớp chính xác origin và cố ý chặn host production hiện tại.

```powershell
node scripts/learning-load-benchmark.mjs --phase submit --base-url https://<staging-host> --confirm-write https://<staging-host> --assignments-file <manifest.json> --virtual-users 1650 --duration-seconds 60 --concurrency 200
```

Kết quả đạt khi p95 start/draft/submit dưới 1 giây, receipt dưới 2 giây, không duplicate và không có 429 do shared NAT. Sau test phải kiểm readback số submission/attendance/evidence/outbox theo assignment, không chỉ nhìn exit code của script.

## 8. Cổng trước production

1. Chốt contract và fixture của toàn bộ dạng Term Test.
2. Migration staging và test rollback/restore đạt.
3. Load test 1.650 người đạt SLO; readback không có duplicate hoặc sai lineage.
4. Kiểm answer key không xuất hiện ở public bundle/API/log/Markdown học viên.
5. Kiểm quyền login `learning_api`, CORS, token hết hạn và retention/purge.
6. Chạy pilot bốn lớp và review buổi 2, 5, 10.
7. Đức và người duyệt phát hành phê duyệt riêng migration production.

## 9. Rủi ro còn mở

- RLS theo từng lớp chưa bật trong migration V1; API đã kiểm quyền theo `reviewer_class_access`, nhưng trước production cần threat-model và quyết định policy database phù hợp với mô hình một service role.
- Worker hiện cung cấp lease/retry/identity guard và `PeriodicReportSystemOutputV1` đã khóa cấu trúc; handler gọi AI, prompt/rubric chuyên môn và API duyệt/phát hành báo cáo vẫn cần hoàn thiện trước khi nối provider.
- Link chọn tên chỉ là `self_confirmed`. Không được truyền thông như xác thực chống gian lận.
- Purge 24 giờ, backup 35 ngày và restore drill là yêu cầu vận hành; chưa có execution trên hạ tầng thật.
