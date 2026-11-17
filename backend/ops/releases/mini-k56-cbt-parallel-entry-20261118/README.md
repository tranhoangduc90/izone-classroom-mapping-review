# Mini Test K56 CBT: lượt riêng, lần nộp hợp lệ đầu

Ứng viên dựng từ byte API K56 build `a97761314ebd14d7b29b5c351c6f8f0402be339d` đã chụp từ container đang phục vụ, giữ mọi overlay Term 1/2 và cấu hình khác. `stage.py` tạo năm tệp thay đổi: admission K56, core riêng Mini, canonical Writing Mini, helper Mini mới và phép nối biên nhận journal. Không rebuild backend từ main.

`miniCbtContinuationVersion:1` chọn lượt CBT riêng của cùng người theo roster. API trả `miniCbtParallelEntry` và tiến độ đã chốt. Mỗi lượt giữ owner/permit riêng. `K56_MINI_CBT_PARALLEL_ENTRY_MODE=on|drain|off` chọn chính sách; `drain` dừng cấp mới nhưng giữ quyền đọc/gửi của lượt đã cấp. Phiếu giấy giữ chính sách riêng. Không bỏ owner guard để làm hồ sơ thứ hai qua được.

Migration additive thêm hai cờ Mini CBT, trigger bất biến và unique index giữ bài chính thức từ lần nộp hợp lệ đầu. Start/draft hoặc báo gián đoạn riêng chưa giữ chỗ. Index phiên cũ tiếp tục loại trừ đúng ba nhóm parallel; Mini paper không được gắn cờ CBT. Không sửa payload, điểm, receipt, timestamp hoặc trạng thái chấm cũ.

Kỹ năng còn mở có thể nhận từ hồ sơ B vào bài chính thức A cùng lớp/người/đề/thế hệ. Receipt giữ scope B và chỉ rõ bài nhận chính thức. Writing Task 2 đọc chính operation đã commit; kiểm phiên, lớp/người, đề, thế hệ, receipt và text trước khi cấp essay cho grading. Bài trắng giữ `blank`, không tạo run/job. Journal tìm receipt qua nguồn nộp B; Term 1/2 và đường Mini cũ còn được kiểm riêng.

## Bằng chứng ứng viên

- RED trên serving: hồ sơ B bị `OFFLINE_OWNER_CONFLICT` sau khi admission trả lại lượt A. Ứng viên cấp hai lượt/phiên độc lập.
- `native-first-valid.test.mjs`: hai thứ tự, Task 2 có nội dung và trắng, giữ lần nộp đầu; B làm tiếp, mất ACK sau commit đọc lại một receipt, chỉ một run/job với bài có nội dung. Từ chối sai người, định nghĩa, thế hệ run/session, receipt và Task. Tuyến log ném lỗi vẫn lưu bài.
- RED trên helper journal đang phục vụ: essay/run đúng nhưng không nối được receipt B. Bản sửa nối được, giữ hai hồi quy Term 1/2.
- `parallel-attempts.test.mjs`: PostgreSQL 16.15 thật, hai giao dịch cạnh tranh có chờ lock trước commit; chỉ một bài chính thức, giữ Mini cũ/paper, người khác độc lập, gián đoạn chưa giữ chỗ và hai Term còn song song.
- Các ca Mini cũ chạy trên core ứng viên: mode off giữ permits/rollback và hai thứ tự CBT; mode on giữ hai thứ tự paper.

Fixture native dùng roster/nội dung giả, PGlite và Listening nộp thủ công ngắn; ca PostgreSQL kiểm giao dịch SQL. Chúng chưa chứng minh browser/cache/audio đủ thời lượng, AI/Portal, tải vận hành hoặc nguồn cloud. Các log/proof nằm trong hồ sơ riêng tư GOAL Test, không đưa định danh thực vào Git.

## Trạng thái và bước phát hành

Gói hiện là **ứng viên, chưa phát production**. Còn ghép giao diện Mini qua cả hai thứ tự, cache cũ, nháp và nộp; kiểm/đọc lại policy và dữ liệu cũ trước chuyển. Cần giữ riêng nguồn browser, API/content và lane cloud theo kế hoạch GOAL. Source recipe và migration không tự phát API, bật cờ, thêm lane hoặc gửi điểm.

Phát hẹp phải clone đúng runtime/env/mount đang phục vụ, đặt ứng viên loopback, kiểm idle và dấu vân tay trong giao dịch migration trước chuyển. Quay riêng mode về `drain` hoặc `off` theo ca đã kiểm; giữ schema/các receipt mới và đường xử lý lượt đã cấp. Không restore dump hoặc bật lại khóa máy cho lượt đang làm. Không drop cờ/index hoặc quay code cũ không hiểu bài Mini mới khi vẫn có lượt/operation cần xử lý.
