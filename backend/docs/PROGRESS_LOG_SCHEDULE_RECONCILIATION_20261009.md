# Progress Log: đối chiếu lịch ERP và giữ đúng buổi

Khi giảng viên nghỉ và ERP chuyển ngày, Journey giữ số buổi cùng mã sự kiện đã xác nhận. Giảng viên mở **Hành trình lớp → Kế hoạch buổi học**, xem ngày trước/sau, chọn ngày hoặc buổi bù rồi lưu. Một buổi chuyển qua ngày của buổi khác vẫn giữ nội dung, link và số buổi.

## Phạm vi vận hành

- Đọc ERP ngay khi mở/làm mới kế hoạch, trước lưu và trước phát phiếu. Trong production, IC2305 (1294) được đọc nền mỗi 5 phút; các lớp khác đọc theo yêu cầu. Biến `LEARNING_SCHEDULE_MONITOR_CLASSES` chọn danh sách ID phân cách bằng dấu phẩy, tối đa 10; đặt chuỗi rỗng để tắt kiểm nền. Không tạo lịch Codex/n8n mới.
- Gộp request cùng lớp; cache kết quả/lỗi 15 giây. ERP chậm hoặc trả thiếu không biến thành lịch rỗng. Dashboard thông báo lỗi và giữ ngày đã chốt. Không gửi thông báo ngoài ứng dụng.
- Chỉ buổi chưa có lượt làm hoặc đích điểm danh được nhận mới được đổi ánh xạ trong đường lưu này. Buổi đã dùng giữ nháp/bài/đích cũ và yêu cầu đối chiếu riêng. Không sửa ERP hay hồi tố Portal.
- Một dòng ERP chỉ thuộc một số buổi. Dòng hủy, mã trạng thái chưa hiểu, mã thiếu hoặc lịch mơ hồ không được tự ghép. Dòng dạy bù mới cần giảng viên chọn; không ghép theo ngày kế tiếp.

## Cách lưu và chống ghi trùng

API `PUT /api/learning/teacher/journey-plan` nhận thêm `operationId` UUID. Cùng mã/nội dung trả kết quả trước; đổi nội dung với cùng mã trả xung đột. Revision kế hoạch và dấu kiểm ERP phải khớp. Khóa lớp dùng chung với publish; khóa assignment dùng chung với start/submit.

Migration `202610090001_journey_schedule_changes.sql` bổ sung `accepted_at` vào binding và bảng `journey_plan_change`. Audit giữ kế hoạch trước/sau, người xác nhận, mã thao tác và ảnh ERP. Không ghi credential hoặc câu trả lời học viên vào audit này.

Mốc Journey 18:25 lấy từ ngày đã xác nhận. `opens_at`/`closes_at` đặt thủ công chỉ dịch theo số ngày thay đổi trước khi buổi được dùng. **Tự khóa 22:00 là ngày người thứ ba nộp đủ**, không lấy từ ngày học và không được dời lại khi sửa lịch.

## Điểm danh và hàng chờ

Nhận bài hoàn chỉnh hoặc điều chỉnh điểm danh lần đầu giữ mã buổi ngay trước enqueue. Binding đã được nhận hoặc đã bắt đầu ghi không đổi theo thứ tự ERP. Khi ảnh lịch đổi sau nhận bài, job được giữ để đối chiếu; không chuyển sang một dòng mới.

Ảnh lịch của binding dùng cùng định dạng chuẩn hóa với resolver Portal: mã lớp và các dòng `[mã buổi, giờ bắt đầu, giờ kết thúc, trạng thái]`, sắp theo giờ. Dấu kiểm SHA256 của kế hoạch phục vụ chống ghi kế hoạch cũ, có vai trò riêng. Workflow Portal chỉ ghi vào mã đã giữ khi ảnh lịch khớp; mã đổi thứ tự ngày không phải lý do chọn mã khác. `already_present` tại đích cũ được dùng để đọc lại một thao tác đã biết; không tạo ý định ghi mới khi đích cần đối chiếu.

Workflow hiện hành: `gnk0f2qZlKr1mIES`, instance `izone-ai`, **Progress Log · Ghi điểm danh Portal**. Chỉ hai Code node quyết định/đọc lại thay đổi; cấu hình, credential, trigger và connections giữ nguyên. Bản trước/sau đã làm sạch nằm trong worktree IZONE AI team của cùng task; bản có cấu hình thật nằm trong kho riêng tư ngoài Git.

## Kiểm chứng và khôi phục

Backend đạt 371/371 ca ở 71 file, PostgreSQL riêng với role ứng dụng; gồm cạnh tranh lưu, rollback audit/cửa sổ, start và nhận bài giữ đích, lịch đổi khi job còn chờ. Lỗi Journey dùng thứ tự ngày có bằng chứng RED trên base và GREEN trên bản sửa. Hai Code node Portal có 8 ca dữ liệu giả, cùng 4 kiểm chạy thật trong workflow thử không có HTTP node.

Production ngày 09/10/2026 dùng image overlay trên đúng image đang chạy; kiểm hash đủ 62 module, giữ toàn bộ source khác và env/cấu hình bảo vệ. Backup database/container được giữ riêng. Khi lỗi, tắt pilot nền hoặc khôi phục container trước; migration chỉ bổ sung tương thích. Không restore toàn database hoặc xóa bài để quay lại. Không ghi lại Portal nếu chưa biết kết quả lần ghi cũ.

Resolver production đã đọc đúng đích IC2305/35819. **Điểm danh thật Buổi 8 còn chờ bài hoàn chỉnh tự nhiên**, chưa có bài học viên giả ở lớp thật. Tài khoản Google Thủy trên thiết bị chưa được quan sát trực tiếp; quyền backend đã kiểm, IC2304 bị từ chối. Kiểm nền mới chạy pilot IC2305; chưa đo tải để bật toàn trung tâm.
