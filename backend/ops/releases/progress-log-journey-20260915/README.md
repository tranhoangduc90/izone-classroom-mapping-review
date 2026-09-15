# Phát hành hành trình học tập Progress Log — 2026-09-15

## Phạm vi

- Image nền: `izone-term-test-backend:20260914.3-k67`.
- Image phát hành: `izone-term-test-backend:20260915.1-progress-log`, image ID `sha256:d826205511f7cd9ffa5d45b458432ca14d3a49d8a007ea89599133a27c80422e`.
- Chỉ thay `learning-routes.js`, `learning-service.js`, `learning-sql.js`.
- Không thay mã Term Test, biến môi trường, secret, volume hoặc cấu hình mạng.
- Schema `learning` được migration sau backup `20260915T091846Z`.

## Kiểm tra bắt buộc

1. `node --test test/*.test.js`: toàn bộ test trong thư mục ứng dụng đạt.
2. Contract identity đạt `check_identity_contract.py`.
3. Image mới chạy `node --check` cho cả ba module vừa thay.
4. Sau khi đổi container: health 200, phiếu demo mở được, link hành trình chỉ trả đúng học viên và không trả raw evidence.

## Rollback

Nếu health hoặc readback nghiệp vụ lỗi, bỏ override này và dựng lại service bằng chuỗi compose trước đó. Image nền `izone-term-test-backend:20260914.3-k67` được giữ nguyên; migration chỉ thêm bảng/cột và không cản mã cũ.
