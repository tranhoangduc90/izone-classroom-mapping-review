# Phát hành Progress Log IC2305 — 2026-09-16

## Phạm vi

- Image nền: `izone-term-test-backend:20260915.1-progress-log`.
- Image mới: `izone-term-test-backend:20260916.1-ic2305`.
- Thêm mẫu Entrance Ticket khóa 56, dashboard live draft và quyền lead tự duyệt có phạm vi theo khóa.
- Không thay Term Test, secret, volume, network hoặc cấu hình PostgreSQL hiện hành.
- Assignment thật chỉ được tạo sau backup, migration, readback quyền và roster IC2305.

## Cổng phát hành

1. Toàn bộ backend test đạt; test Progress Log Pages đạt.
2. Git diff chỉ chứa file Learning/IC2305 và release overlay này.
3. Backup production có marker `VERIFIED` và được sao chép ra ổ E:.
4. Migration `202609160001` được runner áp dụng trong transaction và ghi ledger.
5. Tài khoản lead đang active, có quyền lớp IC2305 và quyền tự duyệt đúng khóa 56.
6. Readback assignment xác nhận buổi 2, roster không rỗng, ba block mở và definition hash đúng.
7. Health, API mở phiếu, Pages và console/network browser đều đạt.

## Rollback

Nếu health hoặc readback lỗi, dựng lại `mapping-review-api` bằng image
`izone-term-test-backend:20260915.1-progress-log`. Migration chỉ thêm bảng quyền và thay trigger;
không xóa dữ liệu cũ. Không xóa assignment đã tạo; đóng assignment và forward-fix nếu dữ liệu
nghiệp vụ cần điều chỉnh.
