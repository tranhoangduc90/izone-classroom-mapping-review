# Xác nhận bài đã lưu Term/Mini — 23/10/2026

Gói này bổ sung endpoint chỉ đọc để client phục hồi khi máy chủ đã lưu Listening/Reading nhưng phản hồi bị mất. Không đổi schema, đề, thời gian, cách chấm hoặc điểm cũ.

`submission-status.mjs` nhận slug/phần và token hiện hành hoặc mã gửi đã có; kiểm generation, trạng thái thay thế và guard chủ audio của K67. Kết quả phân biệt chưa lưu với biên nhận có timestamp, token và snapshot. Không gọi roster, start, dịch vụ chấm hoặc Portal. Đường HTTP dùng lại rate limit đọc, trả `no-store`.

Guard chủ audio K67 chỉ áp Listening. Reading sau reload đọc bằng token lượt; không yêu cầu trang Reading tạo quyền phát audio. Giữ ca RED/GREEN và SQL/HTTP cho ranh giới này.

K67 có bản module giống hệt trong `products/term-mini-k67/src` và mount trong app của sản phẩm. K56 thật/demo đang có các overlay khác nguồn main; `patch-live.py` nhận app trích từ đúng image live, chỉ thêm import/mount và từ chối khi anchor không duy nhất hoặc đã ghép. Image ứng viên phải được so toàn source: chỉ `src/app.js` đổi và thêm `src/submission-status.mjs`. Giữ nguyên dependency, env, mount, mạng, cổng và controller hiện hành.

`submission-status.test.mjs` chạy SQL/HTTP trên PGlite hoặc PostgreSQL riêng qua `SUBMIT_PG_URL`. `SUBMIT_DEPS_PACKAGE` trỏ package đã có dependency được ghim. Fixture tạo schema mới, không được trỏ vào database production hoặc database có bài. PostgreSQL thật bổ sung ca nhiều connection: chưa commit không nhận thành đã lưu; sau commit đọc đồng thời không sửa hàng.

Phát hành API tương thích client cũ trước Pages; kiểm route qua HTTPS và không ghi bài giả vào kho thật. Giữ container/image cũ cho rollback, chỉ quay code khi cần và bảo toàn dữ liệu mới. Bản dump và hash từng hàng lưu riêng tư; không đưa bài/điểm/token/credential vào repository. `healthy` và biên nhận lưu bài không chứng minh AI/Portal đã hoàn tất.

## Sửa tiếp hoặc thêm test mới

Đọc [thành quả, 44 chức năng, bằng chứng và giới hạn](https://github.com/tranhoangduc90/izone-AI-team/blob/main/docs/TERM_MINI_THANH_QUA_VA_BAO_TOAN_2026-10-23.md) cùng [hợp đồng client](https://github.com/tranhoangduc90/izone-ai-team-pages/blob/main/docs/TERM_MINI_SUBMISSION_2026-10-23.md). Đây là baseline phải bảo toàn, không phải xác nhận mọi dịch vụ ngoài đã được kiểm mới.

1. Bài mới khai rõ slug/version, khóa/lớp, mode/order, số câu/Task, thời lượng, công bố và đích điểm. Đăng ký allowlist trong cả module canonical và release, giữ parity. Chạy ca đúng slug/profile mới, sai token/test/generation/snapshot, chưa commit/đã commit, Reading reload và Listening owner.
2. Client phải giữ validator, mã gửi/snapshot bất biến, pending qua reload và guard nộp. Không thay cơ chế Writing revision/blank rule bằng hợp đồng L/R; giữ Mini giấy, legacy, demo và vé thi bù riêng.
3. Kiểm consumer thật của file chung; giữ cả manifest/hồi quy K67/K56. Các ca API giả không thay test SQL/HTTP, runtime public hoặc Portal/thiết bị thật khi phần đó bị tác động. Giữ log thất bại và kết quả chạy bù đúng revision/môi trường.
4. Lấy lại đúng source/image/config live trước phát hành; so toàn phần không đổi. Đối soát từng ID/hash bài/nháp/điểm trước/sau, tách ghi mới hợp lệ khi có lớp đang làm. Rollback code không rollback dữ liệu mới; không restore dump hoặc reset/chấm lại học viên.
