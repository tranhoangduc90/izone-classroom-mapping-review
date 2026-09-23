# Đối chiếu source backend production cho Writing

Ngày 23/09/2026. Đây là hồ sơ branch tích hợp, **không phải bằng chứng được phát hành**. Hai bản đang chạy đều là nguồn chính thức trong phạm vi riêng: container K56 có 30 module `src`, API Term Test chính có 37 module. Snapshot và checksum cây source nằm trong hồ sơ `WRITING_UNIFICATION_LIVE_BASELINE_2026-09-23.md` của workspace; snapshot riêng tư không đưa vào Git.

## Verdict theo từng module chung

`Giữ chung` nghĩa là K56 và API chính đã giống byte; `nhận API chính` nghĩa là branch dùng bản production của API chính. Mọi verdict nhận API chính **còn phải qua thử endpoint hai profile** trước khi đóng U1; không suy từ test unit rằng hotfix K56 đã được bảo toàn hoàn toàn.

| Module | Quan hệ hai bản live | Verdict branch | Bằng chứng/việc còn lại |
| --- | --- | --- | --- |
| `app.js` | Khác | Ghép route theo profile | Route kết quả lớp chọn SQL K56 legacy hoặc API chính; test HTTP hai schema đạt. |
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
| `sql.js` | Khác | Ghép có kiểm soát | Giữ quyền lớp K56 legacy, metadata admin và tách truy vấn kết quả không đọc cột Portal ở schema K56; test PGlite/HTTP đạt. |
| `term-test-assets.js` | Khác | Ghép K56 + API chính | Bản API chính thiếu ba slug K56 dù bản K56 live có đủ. Branch giữ nguyên đường đề/audio và thời gian ba đề K56, đồng thời giữ ba đề API chính; regression RED/GREEN đã xác nhận. Kiểm asset thật hai profile trên bản thử còn mở. |
| `term-test-planning.js` | Giống | Giữ chung | Giống byte. |
| `term-test-portal-sync.js` | Giống | Giữ chung | Vẫn khóa lớp pilot; writer metadata động thuộc U4. |
| `term-test-result-events.js` | Khác | Nhận API chính | Kiểm sự kiện kết quả hai profile. |
| `term-test-writing-grading.js` | Khác | Nhận API chính | Bằng nội dung sau chuẩn hóa CRLF; thử queue/callback hai profile còn mở. |
| `term-test-writing-notifier.js` | Giống | Giữ chung | Giống byte. |
| `term-tests.js` | Giống | Giữ chung | Bằng nội dung sau chuẩn hóa CRLF. |
| `writing-portal-worker.js` | Giống | Bỏ mã riêng nhúng trong source | Lấy từ biến môi trường; test cấu hình đạt; phải kiểm env bản thử. |
| `writing-tests.js` | Giống | Giữ chung | Giống byte. |

Bảy module chỉ có trong API chính (không có ở K56 live) được giữ nguyên: `learning-attendance-sync.js`, `learning-attendance-worker.js`, `teacher-class-access-health.js`, `teacher-class-access-sql.js` và ba template IC2305 trong `learning-templates/`. Không xóa module learning đã có ở Git. Ở mốc `25adb82`, sau chuẩn hóa CRLF, 27/30 module chung khớp API chính. Sau hai bản sửa hòa giải K56, candidate có năm delta có chủ đích: `app.js`, `sql.js`, `term-test-assets.js` và hai worker lấy mã Base từ môi trường.

Test mới đã tái hiện lỗi trên branch nền `a7a3f74`: endpoint `/api/term-tests/teacher/results` của K56 trả **500** vì câu SQL tham chiếu `portal_teacher_contact_id` không có trong schema K56. Trên candidate sau sửa, cùng test đạt **200**, chỉ trả học viên mẫu của lớp được hỏi; giảng viên ngoài lớp bị chặn **403** và admin xem lớp khác với nhãn `admin_override`. Test dùng xác thực Google giả lập ở API, không gọi tài khoản thật. Profile API chính vẫn trả metadata phân công Portal. Đây là lỗi phát sinh khi ghép hai source, không khẳng định production K56 đang lỗi.

Kiểm sâu `term-test-assets.js` tiếp tục phát hiện một lỗi hòa giải khác: branch tích hợp đã lấy nguyên bản API chính, làm mất `term-test-1-k56`, `term-test-2-k56`, `mini-test-k56` và thời gian của chúng. Trên branch trước sửa, regression `ba đề K56 giữ nguyên khả năng đọc và thời gian` **RED** (`supports('term-test-1-k56') = false`); sau khi khôi phục đúng ba entry từ bản K56 live, test **GREEN** và kiểm thêm đọc `content.json` tổng hợp của cả ba slug. Đây là lỗi của **candidate**, không phải bằng chứng production K56 mất đề. Không lấy nội dung đề thật hoặc bài học viên vào Git.

Full backend sau sửa asset K56 đạt **172/172**, skipped 0; `npm run check` đạt. `term-test-assets.js` của candidate nay khớp nội dung với snapshot K56 live sau chuẩn hóa xuống dòng. Cổng U1 vẫn **in progress**: thiếu parity endpoint trên bản thử với hai schema đầy đủ, kiểm các nhánh lỗi và readback; tuyệt đối không dùng bảng verdict này để khởi động deployment production.
