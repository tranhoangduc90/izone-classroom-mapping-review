# Báo sự cố Listening Term Test 1 K56

Chặng này ghép vào runtime K56 đã phục vụ Mini. Dùng `assemble-overlay.mjs`
với bản source vừa đọc lại từ runtime, file bản đồ của Pages và một thư mục
đích mới. Manifest ghi hash của input, overlay và SQL. Giữ nguyên Mini cùng
worker chấm Điểm và cập nhật Portal.

- Offline dùng đúng operation gián đoạn do học viên bấm và permit sở hữu
  lượt. Online dùng bằng chứng HMAC được cấp sau khi thao tác dừng native
  đã nhận. Link Nghe dự phòng dùng grant đã gắn đúng chủ và operation tương
  ứng, sau đó ghi hàng chờ dưới ID lượt gốc.
- Chỉ vị trí thuộc vùng dự kiến nghe thấy trên MP3 đúng hash mới được xếp
  Telegram. Hàng gửi riêng khử trùng theo lượt/thế hệ/thao tác, hỗ trợ ảnh đến
  sau và giữ trạng thái khi mất xác nhận.
- Công tắc `TERM1_K56_LISTENING_REPORT_POLICY_FILE` chỉ áp dụng gửi báo.
  Bot đọc từ mount sẵn có đã xác minh của Mini. Verify quyền ứng dụng trên
  bảng mới bằng SELECT, INSERT, UPDATE trước khi đổi runtime. Giữ bản qua
  kiểm và biên nhận phát hành ở thư mục riêng.

Dùng Node 24 và PGlite cho `listening-report-ingress.test.mjs`. Chạy trong
thư mục mô-đun đã ghép, cùng bản đồ giống Pages và Node dependencies cách ly.
Thử báo đúng, dùng nhầm scope, tải lại rồi dùng mã cũ và thu hồi grant fallback.
