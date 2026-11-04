# Xác nhận học viên từ CTA Reading/Listening 67

Runtime riêng nhận yêu cầu từ bốn native registrars. Mỗi registrar xác minh bản sao Classroom qua Google, kiểm lớp và đúng mã bài, sau đó chỉ ghi hyperlink bằng bộ Docs có sẵn. Học viên cầm link đã đọc lại có thể xác nhận tên một lần. Giao dịch PostgreSQL kiểm lại roster, giữ các mapping đã duyệt và ghi quyết định trước/sau. Native registrar nối lại đúng binding, không bắt đầu bài làm.

## Cấu hình runtime

- Migration `backend/ops/migrations/202611040600_rl67_cta_confirmation.sql` chạy trong `mapping_db` bằng tài khoản vận hành. Runtime dùng login không phải superuser, chỉ kế thừa `rl67_cta_confirmation_api`. Không cấp ghi trực tiếp vào mapping.
- `RL67_CTA_CONFIRMATION_CONFIG` trỏ file JSON private, gồm `databaseUrl`, `signingKey`, bốn `publisherKeys`, bốn `targets` native (URL admin CTA và key) và `mail` với quyền Gmail chỉ gửi. Mỗi sản phẩm đặt `RL67_CONFIRMATION_INTERNAL_URL` và `RL67_CONFIRMATION_<PRODUCT>_KEY_FILE` riêng.
- Public proxy chỉ chuyển `/v1/form` và `/v1/confirm` cùng `Cache-Control: no-store`. Link dùng capability trong fragment. Tuyến `/internal` chỉ dành cho mạng nội bộ và xác thực riêng theo sản phẩm.
- File `/run/rl67/enable` bật xác nhận và phát CTA mới. Khi bỏ file, CTA đã gắn vẫn trả đường chọn tên phù hợp. Quay lại image từng sản phẩm bằng cấu hình trước phát hành, giữ nguyên database và quyết định đã ghi.
- Email cảnh báo qua hàng đợi có lease, thử lại, giới hạn lần và biên nhận Gmail. Không đưa email học viên, Google ID hay DocID vào email báo lỗi.

## Kiểm thử

Chạy `npm ci` và `npm test`. Để chạy phép kiểm trình duyệt, đặt `RL67_CONFIRMATION_PAGES` tới worktree Pages và `PLAYWRIGHT_MODULE` tới module Playwright trên máy. Fixtures không gọi Google thật và không dùng database sản phẩm. Canary đọc Google Classroom/Docs bằng nguồn native, tắt worker và không tạo phiên.
