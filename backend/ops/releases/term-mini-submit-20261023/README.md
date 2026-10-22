# Xác nhận bài đã lưu Term/Mini — 23/10/2026

Gói này bổ sung endpoint chỉ đọc để client phục hồi khi máy chủ đã lưu Listening/Reading nhưng phản hồi bị mất. Không đổi schema, đề, thời gian, cách chấm hoặc điểm cũ.

`submission-status.mjs` nhận slug/phần và token hiện hành hoặc mã gửi đã có; kiểm generation, trạng thái thay thế và guard chủ audio của K67. Kết quả phân biệt chưa lưu với biên nhận có timestamp, token và snapshot. Không gọi roster, start, dịch vụ chấm hoặc Portal. Đường HTTP dùng lại rate limit đọc, trả `no-store`.

K67 có bản module giống hệt trong `products/term-mini-k67/src` và mount trong app của sản phẩm. K56 thật/demo đang có các overlay khác nguồn main; `patch-live.py` nhận app trích từ đúng image live, chỉ thêm import/mount và từ chối khi anchor không duy nhất hoặc đã ghép. Image ứng viên phải được so toàn source: chỉ `src/app.js` đổi và thêm `src/submission-status.mjs`. Giữ nguyên dependency, env, mount, mạng, cổng và controller hiện hành.

`submission-status.test.mjs` chạy SQL/HTTP trên PGlite hoặc PostgreSQL riêng qua `SUBMIT_PG_URL`. `SUBMIT_DEPS_PACKAGE` trỏ package đã có dependency được ghim. Fixture tạo schema mới, không được trỏ vào database production hoặc database có bài. PostgreSQL thật bổ sung ca nhiều connection: chưa commit không nhận thành đã lưu; sau commit đọc đồng thời không sửa hàng.

Phát hành API tương thích client cũ trước Pages; kiểm route qua HTTPS và không ghi bài giả vào kho thật. Giữ container/image cũ cho rollback, chỉ quay code khi cần và bảo toàn dữ liệu mới. Bản dump và hash từng hàng lưu riêng tư; không đưa bài/điểm/token/credential vào repository. `healthy` và biên nhận lưu bài không chứng minh AI/Portal đã hoàn tất.
