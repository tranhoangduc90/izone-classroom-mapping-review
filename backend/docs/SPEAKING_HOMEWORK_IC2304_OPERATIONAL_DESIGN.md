# Thiết kế vận hành Speaking Homework Lesson 3 · IC2304

Ngày đối chiếu: 28/09/2026. Phạm vi phát hành `large_phased`, chế độ `controlled`: chỉ Lesson 3 của IC2304, bốn hội thoại; không có Bác sĩ AI trong bài này. Nguồn nội dung là Google Doc cũ; Google Doc mới là mẫu Classroom để tạo bản sao riêng cho từng học viên. Chưa bật nhận bài cho học viên cho tới khi các cổng bên dưới đạt.

## Hành trình và chủ ghi

Classroom giao bản sao Google Doc cho từng học viên → CTA trong **bản sao** mang Doc ID của chính bản sao, lớp và mã bài → Pages lấy danh sách học viên đã ghép với Classroom → học viên xác nhận đúng tên → API ràng buộc Doc ID với học viên → học viên xác nhận bốn link Share → bộ kiểm đọc hội thoại, kiểm khối lượng và trùng lặp → database tạo một biên nhận → hai việc độc lập ghi ô vàng Docs và chấm Speaking. Trang giảng viên dùng phiên Google và quyền lớp của Mapping API, chỉ đọc biên nhận. Database là nguồn chuẩn của bài đã nộp; Docs là bản xác nhận hiển thị.

Không chấp nhận Doc mẫu chung làm đích nộp; không ghi trạng thái của một học viên vào mẫu chung. Mã lớp trong URL chỉ chọn sẵn giao diện. Nếu Doc ID, học viên và bản sao Classroom không khớp, API từ chối trước khi nhận link.

## Tải, thời gian chờ và chi phí

Classroom hiện có 15 tài khoản IC2304, cả 15 đã được duyệt mapping sau khi Đức xác nhận ba ca ghép tên; hồ sơ ERP thứ 16 không có trong roster Classroom. Giả định tối đa 15 học viên mở đồng thời và 60 lượt kiểm Share (bốn link mỗi người). Xác nhận link trả mã việc ngay, trang báo đang kiểm và hỏi lại trạng thái; không giữ kết nối HTTP mở trong toàn bộ thời gian đọc Share/AI. Mỗi lượt kiểm có tối đa năm lần thử; theo dõi quota Google Docs/Classroom và chi phí AI trước khi nhân rộng.

## Lỗi, phục hồi và quan sát

Link riêng tư, thiếu khối lượng hoặc trùng bài: chỉ phần đó bị từ chối, học viên có thể luyện thêm và xác nhận lại. AI/ChatGPT tạm lỗi: giữ nháp và cho thử lại; không đánh dấu đạt. Lỗi sau khi tạo biên nhận: giữ biên nhận, việc ghi Docs/chấm tiếp tục độc lập, retry có readback để không ghi trùng. Lịch n8n mỗi 30 phút lấy toàn bộ trạng thái của riêng Lesson 3; chỉ ca `TURNED_IN` thiếu biên nhận được gom vào **một email** tới Đức. Mỗi ca có dấu đã gửi trong PostgreSQL; `RETURNED` và ca đã có biên nhận không được báo. Nếu Gmail báo lỗi hoặc không xác nhận được lần gửi, lô đứng ở `sending` để người vận hành đối chiếu thủ công, tránh gửi lặp.

Theo dõi số việc kiểm quá năm phút, kết quả bị từ chối theo mã, biên nhận thiếu dòng Docs, việc chấm chưa hoàn thành và email kiểm thiếu bài. Người vận hành đọc từng lớp kết quả: API nhận, database ghi, Docs hiện, giảng viên xem, chấm hoàn tất. Khi một lớp chưa có bằng chứng, ghi `deployed_awaiting_validation` thay vì `verified`.

## Cổng phát hành và đường lui

1. Duyệt mapping 15 tài khoản, tạo Classroom Lesson 3 theo mẫu và đọc lại Doc ID của từng bản sao.
2. Kiểm migration/role bằng dữ liệu giả, giữ backup và trạng thái API/điểm danh Progress Log trước deploy.
3. Kiểm đủ bốn phần, trùng URL/nội dung/bài cũ, voice warning, timeout/retry, hai tab, đổi người, quyền giảng viên và Docs readback.
4. Chạy bộ test đầy đủ của API và Pages; kiểm một lượt thật có phép thử trên bản sao tạm trước khi bật học viên.
5. Nếu lỗi sau phát hành, tắt cờ Speaking Homework và phục hồi CTA cũ từ snapshot; giữ nguyên biên nhận và dấu chống trùng. Không xóa bài hoặc tắt điểm danh Progress Log.

## Phát hiện khi chuẩn bị chuyển API ngày 28/09

Container API live trước lần phát hành này thiếu `LEARNING_ATTENDANCE_SYNC_URL` và không chứa worker nhận `sync_portal_attendance`; ba việc điểm danh đã đến hạn vẫn ở hàng chờ. Image ứng viên ban đầu kế thừa thiếu sót đó nên không được chuyển thẳng sang production. Bản phát hành đã bổ sung guard cấu hình, worker và ba module điểm danh từ source được kiểm; URL cũ lấy từ container dự phòng ngày 24/09, lưu trong file private trên VPS. Endpoint từ chối phép thử sai quyền với HTTP 403. Canary image mới chạy khỏe và xử lý ba việc điểm danh: hàng chờ chuyển từ 67 hoàn tất + 3 chờ sang 70 hoàn tất + 0 chờ. Đây là bằng chứng worker/contract; vẫn cần đối chiếu outcome Portal và theo dõi sau chuyển container chính.
