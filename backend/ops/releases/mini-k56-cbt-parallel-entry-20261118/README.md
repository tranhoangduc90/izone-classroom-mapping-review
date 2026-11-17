# Mini Test K56 CBT: lượt riêng, lần nộp hợp lệ đầu

Ứng viên dựng từ byte API K56 build `a97761314ebd14d7b29b5c351c6f8f0402be339d` đã chụp từ container đang phục vụ, giữ mọi overlay Term 1/2 và cấu hình khác. `stage.py` tạo năm tệp thay đổi: admission K56, core riêng Mini, canonical Writing Mini, helper Mini mới và phép nối biên nhận journal. Không rebuild backend từ main.

`miniCbtContinuationVersion:1` chọn lượt CBT riêng của cùng người theo roster. API trả `miniCbtParallelEntry` và tiến độ đã chốt. Mỗi lượt giữ owner/permit riêng. `K56_MINI_CBT_PARALLEL_ENTRY_MODE=on|drain|off` chọn chính sách; `drain` dừng cấp mới nhưng giữ quyền đọc/gửi của lượt đã cấp. Phiếu giấy giữ chính sách riêng. Không bỏ owner guard để làm hồ sơ thứ hai qua được.

Một lượt legacy có đủ token, lớp/người, mode và thế hệ được kiểm lại có thể nhận capability mới qua prepare có version. Chỉ thêm cờ ở cùng session/attempt, giữ run, owner/permit, nháp, mốc giờ và mọi operation/receipt. Không tự tạo lượt thay thế cho cache cũ hoặc nâng quyền khi scope trộn sai. Ca `native-warm-adoption.test.mjs` có RED trước thay đổi, GREEN cho chuyển capability tại chỗ và cho chính sách `drain`.

Migration additive thêm hai cờ Mini CBT, trigger bất biến và unique index giữ bài chính thức từ lần nộp hợp lệ đầu. Start/draft hoặc báo gián đoạn riêng chưa giữ chỗ. Index phiên cũ tiếp tục loại trừ đúng ba nhóm parallel; Mini paper không được gắn cờ CBT. Không sửa payload, điểm, receipt, timestamp hoặc trạng thái chấm cũ.

Kỹ năng còn mở có thể nhận từ hồ sơ B vào bài chính thức A cùng lớp/người/đề/thế hệ. Receipt giữ scope B và chỉ rõ bài nhận chính thức. Writing Task 2 đọc chính operation đã commit; kiểm phiên, lớp/người, đề, thế hệ, receipt và text trước khi cấp essay cho grading. Bài trắng giữ `blank`, không tạo run/job. Journal tìm receipt qua nguồn nộp B; Term 1/2 và đường Mini cũ còn được kiểm riêng.

## Bằng chứng ứng viên

- RED trên serving: hồ sơ B bị `OFFLINE_OWNER_CONFLICT` sau khi admission trả lại lượt A. Ứng viên cấp hai lượt/phiên độc lập.
- `native-first-valid.test.mjs`: hai thứ tự, Task 2 có nội dung và trắng, giữ lần nộp đầu; B làm tiếp, mất ACK sau commit đọc lại một receipt, chỉ một run/job với bài có nội dung. Từ chối sai người, định nghĩa, thế hệ run/session, receipt và Task. Tuyến log ném lỗi vẫn lưu bài.
- RED trên helper journal đang phục vụ: essay/run đúng nhưng không nối được receipt B. Bản sửa nối được, giữ hai hồi quy Term 1/2.
- `parallel-attempts.test.mjs`: PostgreSQL 16.15 thật, hai giao dịch cạnh tranh có chờ lock trước commit; chỉ một bài chính thức, giữ Mini cũ/paper, người khác độc lập, gián đoạn chưa giữ chỗ và hai Term còn song song.
- Các ca Mini cũ chạy trên core ứng viên: mode off giữ permits/rollback và hai thứ tự CBT; mode on giữ hai thứ tự paper.

Fixture native dùng roster/nội dung giả, PGlite và Listening nộp thủ công ngắn; ca PostgreSQL kiểm giao dịch SQL. Chúng chưa chứng minh browser/cache/audio đủ thời lượng, AI/Portal, tải vận hành hoặc nguồn cloud. Các log/proof nằm trong hồ sơ riêng tư GOAL Test, không đưa định danh thực vào Git.

Fixture Mini luôn nạp migration gián đoạn K56 phase 2 vì Mini dùng Task 2 nhưng không dùng ràng buộc chỉ Term 1. Đã đối chiếu `k56_listening_interruption_check` đang phục vụ. Browser/native report ca Loa ngoài đã lưu một interrupt, chưa giữ bài chính thức và mở Reading; metadata thực từ browser được envelope trong fixture và đọc qua owner/context/collect vào kho mã hóa cách ly, không suy thành canary Collector VPS/cloud.

## Trạng thái và bước phát hành

Gói hiện là **ứng viên, chưa phát production**. Còn ghép giao diện Mini qua cả hai thứ tự, cache cũ, nháp và nộp; kiểm/đọc lại policy và dữ liệu cũ trước chuyển. Cần giữ riêng nguồn browser, API/content và lane cloud theo kế hoạch GOAL. Source recipe và migration không tự phát API, bật cờ, thêm lane hoặc gửi điểm.

Giao diện Mini đang dùng `runtime-recovery-v1.mjs`, có sửa riêng cho lỗi ghi Listening, pending seal, initial play và telemetry audio. Ghép progress/export an toàn trên nền đó và kiểm đúng nhánh, giữ immutable package cũ; không thay toàn runtime bằng bản Term chỉ vì có sẵn khả năng parallel.

Phát hẹp phải clone đúng runtime/env/mount đang phục vụ, đặt ứng viên loopback, kiểm idle và dấu vân tay trong giao dịch migration trước chuyển. Quay riêng mode về `drain` hoặc `off` theo ca đã kiểm; giữ schema/các receipt mới và đường xử lý lượt đã cấp. Không restore dump hoặc bật lại khóa máy cho lượt đang làm. Không drop cờ/index hoặc quay code cũ không hiểu bài Mini mới khi vẫn có lượt/operation cần xử lý.

Operator `deploy.py` dùng nền API `a97761314` tại loopback 19808, gói ứng viên tại 19809 và bản cùng mã ở `drain` tại 19810. Manifest nhận đúng năm tệp/preimage/hash và SQL; `inspect`, `stage`, `migrate`, `switch` chạy riêng. Stage kiểm đủ dư địa DB, image/env/mount và hash; migration kiểm dấu vân tay trong giao dịch; đổi proxy có backup và tự phục hồi nếu kiểm thất bại. Không in giá trị env/credential ra log.

Sau khi đã có scope Mini mới, `rollback` về mã a977 bị chặn. Dùng `drain` để clone/tái dùng cùng gói tương thích, dừng cấp mới nhưng giữ lượt đã cấp; `resume` chuyển lại bản `on`, giữ schema và receipt. Hai bước ghi riêng log và có thể chạy lại sau diễn tập, không tiêu hao đường lui chỉ dùng được một lần. Không ép reload hoặc sửa dữ liệu để đổi policy. `rollback` proxy cũ chỉ cho khi idle và chưa có scope Mini mới; schema additive vẫn giữ. Ca native drain kiểm chặn hồ sơ mới/giữ hồ sơ đã cấp; phép chuyển cấu hình và hash loopback/public cần được đọc lại ở lần phát thực tế.
