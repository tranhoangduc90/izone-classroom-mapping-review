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

## Term 2 và Mini K56

- Dựng ứng viên Term 1 mới với nguồn Exam Journal hiện tại trước, rồi đưa
  thư mục đó cho stage-shared.py làm đầu vào. Script kiểm SHA-256 của
  k56-offline-core.mjs trước khi ghép phần giữ bản cho Term 2 và Mini.
  Giữ permit, operation, quy tắc giờ, điểm và luồng Listening hiện có.
- Hai migration riêng thêm kho giữ và giới hạn gắn với lượt. Term 2 dùng
  nhóm K56_TERM2_HOLD_CLASSES/HOURS/LIMIT. Mini dùng nhóm K56_MINI_HOLD_CLASSES/HOURS/LIMIT
  và cần K56_MINI_HOLD_PAPER=true để cấp mới cho phiếu. CBT và phiếu Mini
  dùng chung quota kho Mini. Có thể dừng cấp mới bằng cách bỏ lớp và giữ
  thời hạn, quota, quyền tra cùng tiến trình dọn bản hết hạn.
- Với lượt được cấp, seal cần đối soát vì giờ hoặc quy tắc phiếu có biên
  nhận review_required cũ để trình đọc hiểu trạng thái. Nội dung chỉ nằm
  trong kho có thời hạn. Gửi hợp lệ vẫn ghi dữ liệu native và biên nhận
  chính thức. Term 2 bài trắng 0, Mini bài trắng không có điểm Writing.
- Đặt TERM2_RUNTIME_ROOT và MINI_RUNTIME_ROOT trỏ ứng viên, TERM2_DEPS_PACKAGE
  trỏ package cách ly, TERM2_TEST_PG_URL rỗng. Chạy term2-submission-hold.test.mjs
  và mini-k56-submission-hold.test.mjs. Pages chạy bộ K56 term với
  K56_RECOVERY_BROWSER_TERM=2 và K56_RECOVERY_MIGRATION trỏ migration Term 2.
  Bộ Mini cần K56_MINI_FIXTURE_FILE trỏ test.mjs của gói Mini 20261107 và
  K56_MINI_RECOVERY_MIGRATION trỏ migration Mini. Cả hai dùng Collector
  localhost và dữ liệu giả.

## Phiếu Term 1/2 và đường tương thích online

- stage-online.py chỉ ghép k56-exam-order.js nếu hash đúng router đang chạy
  trên VPS1. Hai phiếu Term gọi Listening/Reading của router này với mode
  native cbt theo phiên cũ. Mode answer_sheet riêng tiếp tục dành cho Mini.
- Migration term-online-submission-hold.sql cấp kho riêng cho Nghe/Đọc.
  Cấu hình K56_TERM_ONLINE_HOLD_CLASSES/HOURS/LIMIT mặc định tắt. Lượt nhận
  capability khi client đề nghị qua attempt/prepare và lớp đã xác thực
  nằm trong cấu hình. Tắt danh sách lớp để dừng cấp mới. Giữ TTL, quota
  và API cùng quyền đọc biên nhận cho các lượt đã cấp.
- Chỉ nhận bản chốt khớp định danh lớp, lượt, phiên, thế hệ, kỹ năng và
  định nghĩa. Nội dung được giữ qua một giao dịch trước khi kiểm thứ tự
  và mốc bắt đầu. Giao dịch chính thức ghi bài, điểm vào outbox và biên
  nhận cùng lúc. Khi luồng cũ dùng bản nháp server theo luật thời gian,
  giữ bản vừa gửi riêng, không gắn nhầm biên nhận hoặc đổi điểm chính thức.
- Chạy term-online-submission.test.mjs với TERM2_RUNTIME_ROOT trỏ ứng viên
  đã dựng và TERM2_DEPS_PACKAGE trỏ package cách ly. Kiểm browser
  k56-term-online-recovery-browser.mjs dùng K56_ONLINE_FIXTURE trỏ file
  test native trên cùng ứng viên và các biến Collector thử đã nêu trên.

### Writing trên đường thi máy tương thích

- stage-online-writing.py nhận ứng viên của stage-online.py, file app.js
  đọc từ đúng runtime VPS1 và một thư mục đích mới. Dấu vân tay app.js,
  router và các module chấm được kiểm trước khi dựng. Áp dụng
  term-online-writing.sql sau migration kho Nghe/Đọc. Gói adapter Exam
  Journal cần đồng bộ term.mjs và term-k56-offline.mjs. Nếu trình đọc
  dùng role riêng, kiểm khả năng đọc liên kết biên nhận và lượt bằng role đó.
- Bootstrap chỉ xin capability sau khi xác định đang đi đường tương
  thích. Term 1 nhận Task 2, Term 2 nhận Task 1. API kiểm định danh và giữ
  bản đã chốt trước khi kiểm CAS và đồng hồ. Giữ bản chính thức, biên nhận
  và đúng một việc chấm hoặc điểm 0 bài trắng trong cùng giao dịch. Hết
  hạn theo SQL cũ vẫn chốt bản nháp có sẵn. Khi bản đó khác bản gửi,
  API trả mã đối soát và trình tra chỉ gắn biên nhận với bản được nhận.
- Chạy term-online-writing.test.mjs với cùng package cách ly. Bộ Edge
  k56-term-online-writing-browser.mjs dùng K56_WRITING_FIXTURE trỏ file
  test đó và Collector localhost. Test cắt kết nối sau commit để xác
  minh lần đọc lại và kiểm số việc chấm trực tiếp trong kho.

### Ba đường dự phòng Term 1 K56

- Dựng thêm bằng `stage-term1-fallback.py` trên ứng viên đã có Writing
  online. Script kiểm hash ba module trước khi ghép và cần thư mục đích
  riêng. Dùng migration Term 1 hiện có. Mỗi lượt mới mở qua đường dự phòng
  dùng chung cấu hình lớp, thời hạn và quota Term 1. Lượt đã có chính sách
  tiếp tục dùng giá trị đã ghi. Tắt cấp mới qua danh sách lớp để giữ đường
  đọc và xử lý các bản đã lưu.
- Bản chốt cần đối soát được lưu sau khi xác thực đúng link, thiết bị,
  thế hệ và kỹ năng. Link dự phòng tra bản giữ của chính nó. Khi nhận
  chính thức, cùng operation ID trả lại cùng biên nhận. Bài chính và
  link dự phòng cùng dùng lượt native và đích điểm của kỹ năng đó.
- `term1-submission-hold.test.mjs` chạy qua HTTP và PGlite, kiểm bản giữ
  nguyên văn, một biên nhận, chặn ghi từ bài chính khi link dự phòng đang
  sở hữu kỹ năng và đọc lại khi phản hồi sau commit bị cắt. Log native
  dùng mã lượt chính thức, nối bằng operation ID và receipt ID, không
  chứa bài làm hoặc khóa link. Kiểm trình duyệt, xác thực log trình duyệt
  và cache ba đường dự phòng là phần bàn giao tiếp theo.
