# Thiết kế triển khai Reading buổi 7

## Điều đã chốt và phạm vi nghiệm thu

Giữ mã `67-practice-reading_matching_heading_mcq`, đủ câu 14–26 và 20 phút đang làm. Rời trang/ẩn tab/mất mạng khóa đề và giữ giờ còn lại. Resume không tăng lượt; reset tạo lượt N+1 với đủ giờ và giữ lịch sử. Nộp tay/hết giờ chốt một kết quả bất biến. Giao diện, màu, font, icon và lời giải theo demo đã duyệt, gồm nút mở tại hàng và 138 đoạn màu nguồn.

Nghiệm thu toàn phần đã yêu cầu (`small_complete`), tách bản cục bộ đã kiểm khỏi production. Chưa chọn lớp pilot; không tự mở IC2304, không gửi email, không đồng bộ Portal/ERP, không chấm AI và không đổi hệ thi/Speaking đang chạy.

## Các khu vực trách nhiệm

| Khu vực | Dữ liệu sở hữu | Giao tiếp và phép kiểm |
| --- | --- | --- |
| Danh tính/bài giao | Assignment, binding Docs, token phiên | Ngữ cảnh chỉ đọc v1 → xác minh UUID/lớp; Doc A + học viên B bị chặn; giáo viên có quyền lớp |
| Lượt làm và nộp | Lượt, lease, giờ active, draft sequence, operation ID, kết quả | Transaction khóa một bài cá nhân; kiểm retry, mất ACK, hai tab/thiết bị, stale draft và reset/submit race |
| Nội dung/chấm | Version đề, key, lời giải và màu | Trả đề khi bắt đầu; key/lời giải chỉ sau nộp; 7/3/3 câu, chuẩn hóa có giới hạn từ |
| Docs | Hàng công việc, sequence, bản chữ/link đã ghi, lease | Ghi bắt đầu/hoàn thành; thay đúng vùng do hệ thống quản lý; giữ sửa tay; đọc lại text và link |
| Giao diện | Bản dự phòng trên máy và trạng thái hiển thị | Server là nguồn chính; không báo đã đồng bộ khi chỉ lưu máy; kiểm desktop/mobile và reload thật |

## Ranh giới bản chạy

Product `PRODUCT-READING-PRACTICE-K67`, runtime/release `reading-practice67-api`, API prefix `/reading-practice-api`, PostgreSQL/container riêng `izone-reading-practice67-db`, database `reading_practice_db`, role `reading_practice_app`, schema `reading_practice`. Worker Docs thuộc cùng sản phẩm, không dùng queue Speaking hoặc workflow chấm Reading cũ. Operation/lease/job gắn binding + lượt + phiên bản. Image, env `READING_*`, volume, port và build context riêng.

Dùng lại API nguồn K67 context v1 chỉ đọc, kiểm product nguồn và tuổi tối đa 120 giây; không coi dữ liệu nguồn cũ là quyền hiện hành. API nguồn/VPS/PostgreSQL/Google còn là tài nguyên chung có thể lỗi. Không thay cấu hình/runtime của consumer cũ khi triển khai/quay lui Reading. Quyền DB thật, image/port và đường Nginx cần đọc lại trước production.

Cầu owner v1 thuộc phía nguồn mapping: role `reading_owner_reader`, chỉ đọc view `reading_owner_api_v1.owner` mới, tách credential khỏi API Reading. View nối đúng lớp/course/mapping approved và membership active, không nhận tên làm khóa. Trước binding, API so Google user/course với submission Classroom và attachment Doc thật, rồi kiểm đúng code/tab. Google Docs/StudentSubmission là nguồn đối chiếu tại thời điểm đăng ký. Trạng thái assignment `draft` cho tới khi owner proof và CTA readback đủ; công cụ admin chỉ mở bài sau điều kiện này. Không chỉnh producer/registry dùng chung ở gói hiện tại; đầu vào registration dùng đúng bản sao Classroom, công cụ vận hành gửi riêng từng binding.

## Vận hành

- Giả định kiểm ban đầu: 30 người đồng thời, heartbeat 5 giây (~6 request/giây), autosave sau thay đổi có gom; chưa coi là tải lớp đã đo.
- Lưu máy ngay; checkpoint active mỗi giây, gửi server mỗi 5 giây và khi sửa. Chỉ một lease được ghi; đổi thiết bị phải bấm Tiếp tục để chuyển quyền, phiên cũ bị từ chối.
- Server đo thời gian giữa heartbeat, không cộng thời gian vắng. Nhận lại checkpoint cuối có proof đúng lease, sequence và trần cửa sổ gián đoạn 5 giây. Không nhận giá trị thời gian tùy ý để tăng giờ. Phải đo kill/reload và mất mạng thật; mục tiêu sai lệch 1 giây cùng máy, 5 giây khi đổi máy.
- HTTP người dùng timeout 5 giây; lỗi lưu server thì dừng/che bài, giữ snapshot chờ gửi. Bắt đầu/reset phải có ACK mới chạy giờ. Nộp chưa ACK giữ bài khóa và cùng operation ID để gửi lại.
- Lease tạo ở trạng thái chờ kích hoạt. Trình duyệt nhận ACK rồi đồng thời mở đề/chạy giờ/gửi `/activate`; máy chủ lấy mốc nhận kích hoạt để không cộng thời gian chờ ACK tạo lượt. Kích hoạt retry cùng lease không dời mốc; lease đã pause cần Resume/lease mới. Pulse/exit theo snapshot vẫn phục hồi cửa sổ chưa ACK tối đa 5 giây. Độ trễ gửi kích hoạt chưa đo trên production; không hứa chính xác mili giây.
- Giao dịch tạo lượt/nộp đồng thời tạo job Docs. Lỗi/quota Docs không mất bài; giao diện phân biệt chờ/đã ghi/lỗi. Google request timeout 10 giây, lease worker 60 giây, retry có backoff; 403/conflict chỉnh tay giữ để xử lý.
- Job xử lý theo từng binding/Doc và thứ tự sự kiện. Ghi có requiredRevisionId, đọc lại đúng tab/text/link; sau mất ACK đọc trước khi ghi lại. Không cho sự kiện cũ ghi lùi.
- Theo dõi số job chờ/lỗi, tuổi job, số xung đột lease qua endpoint vận hành có khóa; không tạo lịch/thông báo ngoài yêu cầu.

## Phần sắp làm và kiểm

1. Lượt phục hồi: schema riêng, start/checkpoint/pause/resume/reset/submit; test PostgreSQL local/PGlite thực và HTTP. Kỳ vọng độc lập: 8 phút active + một ngày vắng vẫn còn 12 phút; retry tạo một lượt/submission.
2. Nối Docs: planner, Google adapter, outbox/readback và đăng ký CTA. Kiểm target lệch, nhiều tab/marker, lỗi 403/429, mất ACK, sửa tay và thứ tự start/reset/submit.
3. Nối renderer: giữ CSS/DOM mẫu, thay lớp/người giả và local grading bằng API; browser kiểm trọn luồng, hai tab, mất mạng, token giả, không lộ key trước nộp và một phần lời giải.
4. Chuẩn bị phát hành: package-lock/Docker/schema/role/rollback, đối chiếu source/version, dữ liệu canary và cấu hình riêng. Chỉ xin quyền cho gói cụ thể đã kiểm; chưa có quyền thì không đổi VPS hoặc workflow live.

Review tập trung: định danh Doc–UUID; active clock; idempotency/race; khóa đáp án; ghi Docs không lùi hoặc đè sửa tay. Rollback chỉ image/tuyến Reading; giữ database/bài nộp mới, không restore dump cũ đè dữ liệu.
