# Phục hồi bản chốt Term 1 K56

Ứng viên này dùng bản Term 1 K56 có SHA-256
861110b7f26570fb37d678ad498b7a923f3b572c0dc6e67d594e6d6b1de57209.
Gói dựng kiểm dấu vân tay và thay đúng các điểm nối trong runtime.
Adapter nhật ký giữ cấu trúc sẵn có và dùng chung bộ lọc metadata từ nguồn Exam Journal.

Luồng thử bắt đầu ở bài chính. VPS kiểm permit, lượt, thế hệ, quyền sở hữu kỹ năng,
định nghĩa và kích thước bài trước khi giữ một bản chốt. Kiểm thứ tự, mốc giờ và
revision chạy sau khi giao dịch giữ đã kết thúc. API tra lại trả hash và thời hạn
giữ cho đúng phạm vi. Biên nhận chính thức và điểm tiếp tục theo sổ operation.
Khi một kỹ năng còn cần đối soát, lượt có cờ submissionHoldOnly vẫn gửi được
bản đã chốt của kỹ năng sau qua /offline/hold. API áp dụng cùng quyền và quota,
trả mã/hash để tra bản giữ. Thứ tự nhận chính thức tiếp tục theo /offline/operation.
Mã đã giữ gắn với cùng dấu vân tay qua các lần thử. Bản đã chuyển vào sổ operation
bỏ bản nội dung trùng khỏi kho giữ. Chỉ giữ bộ đếm và mã tham chiếu trong nhật ký.

## Kiểm cách ly

- Dùng runtime fixture khớp dấu vân tay với hai tham số của stage-term1.py.
  Truyền thư mục nguồn Exam Journal qua --journal-source.
  Gói chỉ dựng ứng viên trong thư mục local chưa tồn tại.
- Chạy term1-submission-hold.test.mjs với TERM2_TEST_PG_URL rỗng. Đặt
  K56_RECOVERY_FIXTURE trỏ fixture hiện có, TERM2_RUNTIME_ROOT trỏ ứng viên
  và TERM2_DEPS_PACKAGE trỏ package Node của fixture. Mọi dữ liệu, cấp quyền
  dự phòng và hàng chấm/điểm trong test đều là fixture.
- Bộ kiểm cần đọc bản Writing trước/sau, xác nhận biên nhận sau khi ngắt ACK,
  điểm hay việc chấm không trùng, log không chặn nộp và bản hết hạn được dọn.
- Bộ kiểm Edge trong Pages nhận thêm K56_RECOVERY_WRITING_MIGRATION trỏ
  migration hàng chấm Writing 2026-08-19 của repo backend. Hàng chấm thật
  trong PGlite nhận callback rubric giả và gọi đích điểm giả. Kho EJAR1
  ghi mã biên nhận và job sau khi PostgreSQL đối chiếu đúng lượt, thế hệ
  và bản Writing. Báo cáo tách trạng thái sync native khỏi đọc lại Portal.

## Chuẩn bị phát hành

Quyền ghi nội dung mới được cấp theo migration. Cần kiểm thật quyền tra và
xuất bản giữ, chính sách thời hạn, quota, tải và bản sao dữ liệu theo kế hoạch
trước khi bật lưu thật. Áp dụng migration trước khi cấu hình lớp. Biến
K56_TERM1_HOLD_CLASSES chỉ cấp cơ chế giữ cho lượt mới của danh sách lớp.
K56_TERM1_HOLD_HOURS và K56_TERM1_HOLD_LIMIT ghi lại TTL và quota của lượt
lúc cấp. Dừng cấp mới bằng cách để trống danh sách lớp. Giữ API tương thích
và cấu hình chạy dọn cho đến khi hết lượt được cấp và cửa sổ giữ đã đóng.
Kho giữ chỉ bao phủ seal được cấp qua bài chính ở lát này. Link dự phòng,
các bài khác và đối soát lớp thí điểm có ca riêng trong kế hoạch.
