# Gói phát hành Journey trong Progress Log

Gói này ghép Journey lên image API `speaking-lesson4:20260930-v1` đang chạy ngày 30/09/2026. `prepare-overlay.mjs` dừng nếu mã băm của một module nền thay đổi; Dockerfile kiểm lại chính image trước khi build. Chỉ tám module Journey được phủ. Phiên giảng viên, worker điểm danh, Speaking và các cấu hình hiện hành được giữ từ image nền.

## Đầu vào và đầu ra

- Đầu vào: source của image production đã trích riêng tư, source `backend/src` của branch Journey, và thư mục build trống.
- Việc chính: kiểm image nền, thêm ba nguồn đọc ERP/Test vào `app.js`, thêm bốn cấu hình ERP vào `config.js`, đưa các module Journey vào image.
- Đầu ra: thư mục Docker build kèm `manifest.json` chứa mã băm, không chứa secret. Nếu image nền hoặc điểm ghép đổi, lệnh dừng trước khi build.
- Khi lỗi: giữ API cũ; giảng viên/học viên chưa thấy Journey mới. Không thử ghi đè source khác để qua lỗi.

```powershell
node backend/ops/releases/progress-log-journey-20260930/prepare-overlay.mjs `
  'E:\Codex-Data\progress-log-journey-release-20260930\live-source' `
  backend `
  'E:\Codex-Data\progress-log-journey-release-20260930\overlay'
```

Trước chuyển bản: áp migration `202609290001_teacher_confirmed_journey_plan.sql` sau backup PostgreSQL; kiểm đầy đủ cấu hình điểm danh, worker, hàng chờ và đích Portal; cấu hình ba biến Metabase trong kho riêng tư trên VPS. Đọc thử lịch ERP từ chính container và truy vấn Test trên database thật. Sau build, chạy toàn bộ test trên cây source overlay, kiểm phiên giảng viên 90 ngày và kiểm API Journey trên lớp được phép. Không phát hành Pages trước API.

Sau chuyển bản: kiểm `/ready`, một phiếu đang dùng, Journey của đúng lớp/học viên, kế hoạch giảng viên lưu rồi đọc lại, hàng chờ `sync_portal_attendance`, cấu hình đích không đổi và outcome đọc lại từ Portal. Giữ container cũ để rollback tức thì; migration thêm bảng nên không xóa bảng khi quay code. Nếu không có event điểm danh mới, ghi trạng thái `deployed_awaiting_validation` và hẹn kiểm lại, không gọi là đã nghiệm thu Portal.

## Khác biệt đã phát hiện

Source Term Test trên branch và image production có hợp đồng dashboard khác nhau. Test của branch đòi `accessMode`/`isAssignedTeacher`; image đang chạy chỉ trả `id`/`name` cho endpoint đó. Gói này giữ hợp đồng image hiện hành. Khi chạy 256 test trên cây overlay, 255 đạt và đúng test Term Test này không đạt. Cần xử lý riêng chênh lệch source production trước khi gọi full suite trên image cuối là đạt; không sửa hợp đồng Term Test trong đợt Journey.
