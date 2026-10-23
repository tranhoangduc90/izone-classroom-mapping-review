# Progress Log — cổng giảng viên chung và cập nhật trực tiếp

Gói ứng viên theo Plan V2.1, phương án B. Chưa coi việc có source/image là đã phát hành. Kết quả tải và readback của từng lần chạy phải đi cùng phiên bản sẽ bật; không dùng bài nộp thử của học viên thật để lấp bằng chứng.

## Hành vi

- `teacher.html` mở danh sách lớp theo quyền hiện hành. Link phiếu mở thẳng đúng phiếu; `teacher-thuy.html` giữ làm alias cùng renderer. Không cố định giảng viên hoặc lớp1294. Kho bài tập tải riêng, lỗi kho không chặn danh sách lớp.
- Header52px theo preset Thủy có Làm mới và tín hiệu kết nối. Giữ panel, ô nhận xét đang viết, câu chọn, bộ lọc và vị trí cuộn khi đọc lại.
- Thông báo SSE chỉ chứa mã phiếu, revision và trạng thái đường thông báo. Bài làm vẫn qua HTTP có xác minh phiên/quyền. Không ghi nhận tham gia, phát lại nộp bài hoặc điểm danh từ thao tác Làm mới.
- Màu xanh chỉ xuất hiện sau tín hiệu thật và khi màn đã áp dụng đủ dữ liệu. Lỗi đọc toàn màn không được heartbeat che đi. Mất đường thông báo dùng đọc bù/dự phòng, giữ dữ liệu đã có.
- Phiên Google chung vẫn90 ngày không hoạt động/trần365 ngày, đăng xuất chung. Chuẩn bị lại kế hoạch SQL không cache kết quả xác thực: trạng thái tài khoản, thu hồi và hạn vẫn kiểm mỗi lần.

## Thành phần

- Migration `202610230001_teacher_live_updates.sql`: hai bảng revision/change, backfill mốc0 cho phiếu cũ, trigger của các writer và NOTIFY trong cùng transaction. Mỗi assignment chỉ tăng một revision trong một transaction; nhiều writer vẫn ghi đủ scope/người, transaction kế tiếp tăng mốc mới. Chỉ cấp SELECT revision cho `learning_api`; rollback không phát revision giả.
- `learning-realtime.js`: một LISTEN/process, gộp600ms, SSE metadata, heartbeat15s kiểm phiên/quyền, đọc bù các phiếu đang xem. Giới hạn stream/bộ đệm; không giữ connection PostgreSQL cho từng giảng viên.
- Snapshot HTTP dùng một transaction chỉ đọc để giữ cùng revision/dữ liệu và tránh xếp hàng lại sau từng vùng. Nháp đọc đúng nhóm học viên đổi; chỉ tính analytics lại khi nguồn liên quan đổi.
- `learning-query-plans.js`: đặt tên các SQL cố định của Learning và đúng câu kiểm phiên; PostgreSQL dùng lại kế hoạch, giữ nguyên tham số, quyền, khóa và lỗi. Không đổi query thành cache quyền.
- `auth.revalidate()` chỉ kiểm cookie hiện hành cho kết nối dài; không gửi cookie sau khi stream đã mở.

Luật nghiệp vụ giữ nguyên: lần nộp phần đầu thành công ghi nhận tham gia, kể cả để trống; Portal chỉ hiện thành công sau outcome/readback đúng đích. Thống kê theo câu vẫn lấy phiếu nộp cuối. Nháp nhận xét vẫn riêng và chỉ hiện cho học viên khi công bố. Không đổi đề, đáp án, luật chấm hoặc hạn của phiếu đã phát.

## Cấu hình và giới hạn

| Cấu hình | Ý nghĩa |
|---|---|
| `LEARNING_REALTIME_ENABLED` | Mặc địnhfalse; bật sau migration và kiểm API. False giữ đường đọc tương thích |
| `LEARNING_REALTIME_STREAM_ENABLED` | Mặc địnhtrue khi bật tính năng. False giữ đọc revision/delta và chế độ dự phòng |
| `LEARNING_REALTIME_CLASS_IDS` | Danh sách ERP class ID ngăn cách bằng dấu phẩy; đợt thí điểm đặt`1294`(IC2305). Máy chủ kiểm scope và options đánh dấu từng phiếu; lớp khác giữ đường đọc cũ/Làm mới. Rỗng nghĩa toàn bộ lớp được cấp quyền, chỉ dùng khi đã chủ động mở rộng |
| `LEARNING_DB_POOL_MAX` | Thử10/15/24; bản ứng viên cuối dùng15 trong kho thử, Mapping pool5. Pool24 không giải quyết ca nộp dồn; chưa áp dụng production |

Phạm vi cuối Đức chốt là **30 lớp ×18 học viên =540 người**, không cần50 hoặc100 lớp. Các ngưỡng1s lưu nháp/2s cập nhật và nộp là mục tiêu thử, không phải bảo đảm đã đạt. Báo riêng mẫu số lớp/học viên, số tab, nhịp ghi, quota CPU/RAM, độ trễ và lỗi. Không suy khả năng tải từ HTTP200 hoặc số case test.

Nhịp autosave học viên chưa đổi trong gói ứng viên:5–12s khi ngừng gõ, tối đa25–45s. Mức2–3s/max10 của plan chỉ được bật sau phép tải phù hợp; không gọi chữ chưa gửi lên máy chủ là dữ liệu trực tiếp đã nhận.

## Kiểm chứng và thử tải

Các script fixture chỉ nhận PostgreSQL riêng tại loopback16547 và tạo database tên ngẫu nhiên. Không nhận URL production. Gồm HTTP/SSE thật, cookie phiên giả qua `createAuthService`, role `learning_api` và đối chiếu bài/attendance/outbox. Không gọi Google, broker hoặc Portal thật.

`scripts/learning-realtime-load.mjs` dựng API/kho giả; `learning-realtime-generator.mjs` chạy process riêng, nhận model qua IPC. Nó thử10 rồi30 lớp×18 người, hai tab/giảng viên và540 người nộp trong30s. Máy phát tải có thể chạy ngoài VPS qua SSH loopback để tách chi phí phát tải khỏi API; không nhận origin production. Báo cả yêu cầu lỗi, còn chờ, bị bỏ do bận và dữ liệu chưa tới người xem; vượt ngưỡng vẫn là chưa đạt. Thống kê API và máy phát tải tách riêng. Ca trình duyệt Pages kiểm tiếp việc áp dụng vào DOM/giữ nháp, không thay bằng chứng DB/HTTP. Giữ riêng các lượt25 người trước khi Đức giảm phạm vi; không đổi tên hoặc mẫu số biên nhận cũ.

Nhóm PostgreSQL kiểm commit/rollback, quyền, mất listener, thu hồi phiên/lớp, điểm danh sớm và không nhân tác vụ. Nhóm kiểm phiên thật trên DB bảo đảm prepared statement không giữ quyền hoặc phiên đã thu hồi. Dọn fixture bằng DROP thường sau khi đóng pool; FORCE từng gây FATAL giả khi nhiều socket vừa đóng.

Kết quả và giới hạn của bản ứng viên23/10 nằm ở [CAPACITY.md](CAPACITY.md). Hiện đã nhận đủ540 bài giả nhưng chưa đạt đều mục tiêu độ trễ khi nộp dồn; không gọi là đã nghiệm thu tải hoặc đã phát hành.

## Phát hành và quay lại

1. Đối chiếu image/module live và cấu hình đầy đủ, sao lưu riêng tư. Giữ worker `sync_portal_attendance`, đích/hash cấu hình điểm danh, cookie, thư mục gắn và mạng. Không in secret vào log/source.
2. Chạy migration bằng chủ database theo runner hiện hành. Không reset dữ liệu, chấm lại hoặc thay phiếu đã phát.
3. Overlay đúng module trên image live. Riêng app chỉ ghép hunk Learning, giữ các overlay sản phẩm khác; giữ `createLearningAttendanceSync({config,pool:learningPool})`.
4. Chỉ thêm proxy cho `/mapping-api/api/learning/teacher/assignments/<uuid>/events`: HTTP1.1, không buffer/cache/gzip, timeout dài hơn heartbeat. Không nâng timeout toàn API; kiểm `nginx -t` và giữ bản quay lại.
5. Chuyển API và Pages trong quyền đã có. Đọc lại hash source/asset, flags và cookie thực tế. Giữ preset, grant lớp bổ sung và thư viện đăng nhập chung.
6. Kiểm Google/phiên đang có mở đúng lớp/phiếu, stream qua HTTPS ít nhất hai heartbeat, đổi lớp/tab, Làm mới và lỗi đọc. Không tạo attempt/nộp bài/ghi Portal để kiểm đăng nhập. Đối chiếu hàng chờ và outcome Portal đúng phạm vi được phép; thiếu ca mới thì ghi rõ, không gọi Portal đã kiểm mới.

Nếu đường stream có vấn đề, tắt riêng stream để dùng dự phòng. Nếu phải quay runtime, dùng image/container cũ đã giữ; giữ schema bổ sung và bài phát sinh, không restore database cũ để quay code. Đánh giá trigger nếu cần vô hiệu hóa trong sự cố; không xóa bảng/bài để thử cho qua.
