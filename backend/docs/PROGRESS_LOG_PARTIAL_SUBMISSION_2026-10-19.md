# Nộp câu trống và điểm danh từ phần đầu

Học viên được nộp từng phần hoặc phiếu cuối dù còn câu trống, kể cả trống toàn bộ. Câu có chấm bỏ trống nhận 0 điểm và giữ nguyên mẫu số. Reflection và nội dung không chấm vẫn là chưa trả lời; không tạo điểm hay lượt AI cho nội dung trống. Câu điều kiện không áp dụng được loại khỏi kết quả chấm.

Ngay khi checkpoint đầu tiên được lưu thành công, cùng giao dịch lưu ghi nhận tham gia, lịch sử và yêu cầu đồng bộ Portal. Không cần nộp cuối. Mở phiếu, chọn tên và lưu nháp chưa điểm danh. Các phần còn khóa/chưa nộp giữ trạng thái cũ; hạn nộp và quyền lớp vẫn được máy chủ kiểm.

## Tương thích và giảng viên

- Không sửa cờ `required` của definition đã phát hành, không chấm lại hoặc điểm danh bù lịch sử.
- Bài cuối còn trống vẫn đọc được trong Journey qua kiểm quyền và identity hiện hành.
- Retry, phần tiếp và final không nhân yêu cầu tự điểm danh đã có; client cũ nộp cuối trực tiếp vẫn được ghi nhận.
- Quyết định của giảng viên được giữ. Khi giảng viên đổi sang chờ kiểm/không đủ điều kiện, lệnh còn chờ bị hủy quyền chạy. Lệnh đang xử lý cần đối soát; không tự hoàn nguyên Portal.
- Worker kiểm lại lease, điểm danh và identity ngay trước HTTP. Database và Portal không có giao dịch nguyên tử chung: quyết định cạnh tranh sau kiểm cuối vẫn có thể gặp lệnh đang gửi. Dashboard ghi rõ kết quả chưa xác định, không báo đã hủy hoặc đã đồng bộ khi chưa có bằng chứng.

## Phần phát hành

1. Giữ snapshot nguyên workflow `Progress Log · Ghi điểm danh Portal`. Cập nhật node xác thực nhận `LearningPortalAttendanceCheckpointJobV1`, vẫn nhận hai loại tác vụ cũ. Nguồn checkpoint dùng mã checkpoint riêng, không giả thành submission.
2. Sao lưu database; áp migration `202610190001_checkpoint_attendance_source.sql` bằng owner. Migration chỉ thêm hai cột nguồn và quyền cột, không cập nhật bài/điểm danh cũ.
3. Image API phải ghép bảy module production đã kiểm lên image live, giữ nguyên mọi module khác, cấu hình, mount, mạng, auth 90/365 ngày và consumer điểm danh. Phần demo dùng source/khởi tạo riêng; không đưa dependency PGlite vào API production.
4. Phát Pages sau API. Đối chiếu asset, giao diện thật, hàng chờ và outcome Portal. Demo/local không thay bằng chứng ghi mới lên Portal; khi chưa có lượt thật mới ghi `deployed_awaiting_validation` cho phần đó.

Quay lui bằng container/image API trước chuyển và bản Pages/workflow trước đổi; giữ database có cột mới và mọi bài đã nhận. Không xóa cột hoặc khôi phục dump đè bài mới chỉ để quay code.

## Kiểm và bằng chứng

Ca mới nằm trong `learning-early-attendance-postgres.test.js`, `learning-checkpoint-portal-contract.test.js`, `learning-domain.test.js` và `learning-early-attendance-browser.mjs`. Kiểm PostgreSQL bằng role ứng dụng gồm trống toàn bộ, replay, final không trùng, rollback khi lỗi quyền, 20 học viên đồng thời, điều chỉnh GV trước/trong pha ghi. Chrome dùng Pages/API/SQL thật, mạng ngoài loopback bị chặn, viewport 390/1440 và xem lại bài còn trống trong Journey.

Báo cáo kết quả từng lượt và bản đọc production được lưu riêng tư tại thư mục bằng chứng của task `progress-early-attendance-20261019` trên ổ E; không đưa dump, credential hoặc dữ liệu học viên vào Git.
