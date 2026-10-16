# Phát hành K67 audio và làm quen — 16/10/2026

Gói này ghép các lát audio/làm quen đã xây với giao diện Reading xám sáng–đỏ. Phạm vi là Term 1/2, Mini Buổi 5 CBT và trang làm quen riêng; giữ phòng chờ Listening, không đổi K56, không dựng lại backend chung, không thay workflow chấm/Portal.

## Điều kiện và thứ tự thực hiện

1. Đọc metadata live, xác minh image/config, giữ nguyên khóa phiên/asset; sao lưu cấu hình riêng bằng DPAPI và dump nhất quán K67.
2. Phục hồi dump vào kho local mới; chạy 010–015 ở bản phục hồi và đối chiếu các cột/hàng lịch sử không đổi.
3. Khi không còn phiên Listening trong hạn đang mở, chỉ áp migrations còn thiếu 010 → 015. Thao tác khóa có timeout; không chạy lại schema/bootstrap hoặc restore dump đè production.
4. Dựng image từ Dockerfile, lockfile và **toàn bộ cây src**, gồm thư mục audio làm quen. Kiểm hash từng file bên trong image. Không dùng helper cũ chỉ glob src/*.js vì sẽ bỏ audio làm quen.
5. Khởi động candidate riêng, cờ mới tắt, giữ quota và secret hiện hành; kiểm ready/version. Giữ container cũ để quay lại.
6. Phát hành Pages đã ghép và đọc lại tài nguyên. Đổi sang runtime mới cùng DB, bật `K67_AUDIO_INCIDENT_ENABLED`, `K67_AUDIO_CACHE_ENABLED`, `K67_AUDIO_OWNER_ENABLED`, `K67_READINESS_ENABLED`; `K67_READINESS_CLASSES` lấy đúng tập lớp K67 hiện đang được cấp quyền. Query client không mở được lớp khác.
7. Kiểm Chrome/Edge trên URL thật: đăng nhập làm quen, lưu/nộp/reload, Reading/Writing, không gọi route đề thật; kiểm CORS và asset. Kiểm bài thi dùng fixture giả với chính mã phát hành; không mở/nộp bài người học thật hoặc gửi điểm giả vào Portal để probe.

## Quay lui và bảo toàn bài

- Giữ image/container/cấu hình trước chuyển, image ứng viên đã xác minh, dump trước migration và revision Pages trước/sau. Giữ khóa phiên, asset đã ghim và DB hiện hành.
- Nếu chưa có phiên protocol audio mới, có thể dừng runtime mới và khởi động container cũ trên cùng cổng/kho đã nâng schema; schema bổ sung không cần gỡ. Kiểm health/quyền/lưu/nộp và consumer sau chuyển.
- Nếu đã có phiên protocol mới chưa đóng hoặc chưa rõ, giữ runtime hiểu 010–015 và các cờ; điều phối giảng viên xử lý/đóng phiên trước khi hạ image. Không tắt cache/owner/incident, không giảm hạn hoặc sửa nháp để vượt giữ bài. Sửa phần trình bày có thể phát hành riêng nếu không đổi hợp đồng engine.
- Bài làm quen: ưu tiên giữ dịch vụ và để người đang làm lưu/nộp xong trước khi tắt. `K67_READINESS_ENABLED=false` chặn cả phiên cũ; phải thông báo đúng ảnh hưởng. Không DROP bảng, restore dump cũ hoặc xóa dữ liệu mới.
- Không xây công tắc ngừng mở mới theo yêu cầu mới nhất của Đức. Điều phối ngừng mở rộng do người vận hành thực hiện, không hứa có tính năng đóng mềm.

## Giới hạn cần báo đúng

Bộ tự động kiểm lỗi/phục hồi và trạng thái người dùng thấy, không ký thay xác nhận tiếng qua tai nghe. Sleep Windows đã bỏ theo yêu cầu. Giới hạn quan sát mute Windows/tab, extension, Bluetooth, ứng dụng gọi/họp và mạng lớp vẫn áp dụng. Kết quả tải localhost không chứng minh production chịu hàng trăm người; nâng năng lực hạ tầng là việc riêng.

Người vận hành/giảng viên xử lý trực tiếp hoặc qua chat khi vượt khả năng tự phục hồi; chưa có nút giáo viên cấp thêm giờ hay thu hồi quyền máy hỏng. Không tự sửa DB để ép thi tiếp.

Biên nhận riêng tư của lần phát hành: `E:/Codex-Data/k67-production-audio-20261016/`. Trạng thái thực tế chỉ xác nhận từ readback trong thư mục này; tài liệu mô tả cách làm không thay biên nhận.
