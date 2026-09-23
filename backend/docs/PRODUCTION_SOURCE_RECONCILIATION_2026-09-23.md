# Đối chiếu source backend production cho Writing

Ngày 23/09/2026. Đây là hồ sơ branch tích hợp, **không phải bằng chứng được phát hành**. Hai bản đang chạy đều là nguồn chính thức trong phạm vi riêng: container K56 có 30 module `src`, API Term Test chính có 37 module. Snapshot và checksum cây source nằm trong hồ sơ `WRITING_UNIFICATION_LIVE_BASELINE_2026-09-23.md` của workspace; snapshot riêng tư không đưa vào Git.

## Verdict theo từng module chung

`Giữ chung` nghĩa là K56 và API chính đã giống byte; `nhận API chính` nghĩa là branch dùng bản production của API chính. Mọi verdict nhận API chính **còn phải qua thử endpoint hai profile** trước khi đóng U1; không suy từ test unit rằng hotfix K56 đã được bảo toàn hoàn toàn.

| Module | Quan hệ hai bản live | Verdict branch | Bằng chứng/việc còn lại |
| --- | --- | --- | --- |
| `app.js` | Khác | Nhận API chính | Kiểm route của cả hai profile. |
| `auth.js` | Khác | Nhận API chính | Kiểm admin và giảng viên theo lớp. |
| `config.js` | Khác | Nhận API chính | Kiểm cấu hình riêng từng deployment. |
| `db.js` | Giống | Giữ chung | Giống byte. |
| `deployment-profile.js` | Khác | Nhận API chính | Unit test ba profile; endpoint parity còn mở. |
| `erp-sync.js` | Giống | Giữ chung | Giống byte. |
| `k56-portal-pilot.js` | Giống | Giữ chung | Vẫn chỉ cho lớp pilot; mở mọi lớp là U4, không tự mở ở U1. |
| `lark-client.js` | Giống | Giữ chung | Giống byte. |
| `lark-replica-definitions.js` | Giống | Giữ chung | Giống byte. |
| `lark-replica-worker.js` | Giống | Bỏ mã riêng nhúng trong source | Lấy từ biến môi trường; test cấu hình đạt; phải kiểm env của bản thử trước khi chạy. |
| `learning-contracts.js` | Khác | Nhận API chính | Bằng nội dung sau chuẩn hóa CRLF; learning suite đạt. |
| `learning-domain.js` | Khác | Nhận API chính | Bằng nội dung sau chuẩn hóa CRLF; learning suite đạt. |
| `learning-evidence-adapters.js` | Giống | Giữ chung | Giống byte. |
| `learning-outbox.js` | Khác | Nhận API chính | Bằng nội dung sau chuẩn hóa CRLF; learning suite đạt. |
| `learning-reports.js` | Giống | Giữ chung | Giống byte. |
| `learning-routes.js` | Khác | Nhận API chính | Kiểm endpoint learning riêng profile. |
| `learning-service.js` | Khác | Nhận API chính | Kiểm endpoint learning riêng profile. |
| `learning-sql.js` | Khác | Nhận API chính | Kiểm schema riêng profile. |
| `mini-tests.js` | Giống | Giữ chung | Giống byte. |
| `server.js` | Khác | Nhận API chính | Bằng nội dung sau chuẩn hóa CRLF; khởi động từng profile còn phải thử. |
| `sql.js` | Khác | Ghép có kiểm soát | Giữ truy vấn quyền lớp K56 legacy và metadata admin; kiểm PGlite đạt, endpoint parity còn mở. |
| `term-test-assets.js` | Khác | Nhận API chính | Bằng nội dung sau chuẩn hóa CRLF; kiểm asset hai profile còn mở. |
| `term-test-planning.js` | Giống | Giữ chung | Giống byte. |
| `term-test-portal-sync.js` | Giống | Giữ chung | Vẫn khóa lớp pilot; writer metadata động thuộc U4. |
| `term-test-result-events.js` | Khác | Nhận API chính | Kiểm sự kiện kết quả hai profile. |
| `term-test-writing-grading.js` | Khác | Nhận API chính | Bằng nội dung sau chuẩn hóa CRLF; thử queue/callback hai profile còn mở. |
| `term-test-writing-notifier.js` | Giống | Giữ chung | Giống byte. |
| `term-tests.js` | Giống | Giữ chung | Bằng nội dung sau chuẩn hóa CRLF. |
| `writing-portal-worker.js` | Giống | Bỏ mã riêng nhúng trong source | Lấy từ biến môi trường; test cấu hình đạt; phải kiểm env bản thử. |
| `writing-tests.js` | Giống | Giữ chung | Giống byte. |

Bảy module chỉ có trong API chính (không có ở K56 live) được giữ nguyên: `learning-attendance-sync.js`, `learning-attendance-worker.js`, `teacher-class-access-health.js`, `teacher-class-access-sql.js` và ba template IC2305 trong `learning-templates/`. Không xóa module learning đã có ở Git. Sau chuẩn hóa CRLF, 27/30 module chung của candidate khớp API chính; ba delta là hai worker nêu trên và `sql.js`.

Kiểm cục bộ tại commit `25adb82`: 170/170 test, skipped 0; `npm run check` và cú pháp 37 module đạt. Cổng U1 vẫn **in progress**: thiếu ma trận request/response cùng dữ liệu thử trên hai schema, kiểm các nhánh lỗi và readback; tuyệt đối không dùng bảng verdict này để khởi động deployment production.
