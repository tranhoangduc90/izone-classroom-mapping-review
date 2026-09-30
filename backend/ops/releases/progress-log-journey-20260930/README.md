# Gói phát hành Journey trong Progress Log

Gói này ghép Journey lên image API `speaking-lesson4:20260930-v1` đang chạy ngày 30/09/2026. `prepare-overlay.mjs` dừng nếu mã băm của module nền thay đổi; Dockerfile kiểm lại chính image trước khi build. Mười một module được phủ: Journey cùng `server.js`, `sql.js` và `term-test-writing-grading.js` từ branch đã qua full suite. Các module thêm này khôi phục giới hạn bốn việc chấm Writing, phiên thông báo chấm và quyền lớp Term Test đang có trong source Git. Worker điểm danh và các module Speaking giữ từ image nền; mã lớp có dấu chấm tiếp tục được nhận.

## Đầu vào và đầu ra

- Đầu vào: source của image production đã trích riêng tư, source `backend/src` của branch Journey, và thư mục build trống.
- Việc chính: kiểm image nền, đưa các module Journey và ba module Term Test đã đối chiếu source–image vào image.
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

Source Term Test trên branch và image production có hợp đồng dashboard khác nhau. Test của branch đòi `accessMode`/`isAssignedTeacher`; image đang chạy chỉ trả `id`/`name` cho endpoint đó. Gói này giữ hợp đồng image hiện hành. Sau khi ghép `main` Speaking buổi 4, source branch đạt 263/263 test. Khi chạy cùng bộ test trên source trích nguyên từ image production cộng tám module Journey, 260/263 đạt. Ba ca không đạt: trường dashboard Term Test khác branch; query Term Test của image đòi cột `class_started_at` mà fixture migration branch chưa có; giới hạn job chấm Writing thực tế là 6 thay vì 4 mà test branch đòi. Ca giới hạn 6/4 cũng không đạt khi chạy riêng. Đây là chênh lệch baseline image Git, không được tự sửa Term Test trong đợt Journey.

Image ứng viên cuối `izone-progress-log-journey:20260930-rc2` đã build trên VPS từ đúng image đang chạy, giữ nguyên hash worker điểm danh. Full suite trên source tương ứng image đạt 264/264, gồm ca hồi quy mã lớp có dấu chấm và phiên giảng viên 90 ngày. Cấu hình image ứng viên đọc được 31 dòng ERP của IC2305; 67/67 yêu cầu điểm danh đã hoàn tất của buổi 2–5 đọc lại khớp đúng dòng Portal. Migration đã áp sau backup schema `learning`; bảng mới chưa có kế hoạch lớp. Ba bài Test đang ở mức định nghĩa, chưa có roster/kết quả riêng IC2305, nên không gán vị trí Test khi lập kế hoạch. Cần chuyển API, phát hành Pages và xác nhận kế hoạch bằng dashboard đăng nhập thật, rồi quan sát luồng sau chuyển bản trước khi gọi production đã nghiệm thu.
