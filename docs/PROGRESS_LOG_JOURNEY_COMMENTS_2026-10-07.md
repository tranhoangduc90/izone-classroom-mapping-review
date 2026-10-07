# Hành trình riêng và nhận xét theo buổi — bản thực hiện 07/10/2026

Giáo viên bấm **Hành trình riêng** cạnh tên để mở đúng học viên. Link mới không hết hạn; lấy lại link ở lần khác hoặc máy khác vẫn giữ nguyên. Trong bài làm hoặc ô buổi học, giáo viên có thể thêm, sửa hoặc ẩn nhận xét. Học viên đọc nhận xét trong hành trình riêng, hành trình mở từ phiếu, chi tiết buổi và màn biên nhận.

Đây là tính năng bổ sung cho Progress Log hiện có. Luồng nộp bài, chấm, khóa phần, hạn nộp, phản hồi Speaking, tổng kết và điểm danh giữ cơ chế riêng.

## 1. Những phần đã thực hiện

| Phần | Cách hoạt động |
|---|---|
| Link riêng | Server phát mã ngẫu nhiên; mỗi lớp–học viên có một link đang hoạt động. Link nằm sau dấu `#` trong địa chỉ trang. |
| Không hết hạn | Link mới có hạn là NULL. Chỉ thao tác Thay link/Thu hồi link làm mất hiệu lực link đang dùng. |
| Link đã gửi trước đây | Giữ nguyên mã và trạng thái. Link cũ chỉ lưu hash nên server không lấy lại bản gốc để sao chép; GV dùng link đã gửi hoặc chủ động thay. |
| Nhận xét | Một nhận xét hiện hành cho một lớp–học viên–buổi, 1–1.000 ký tự Unicode. Không cần đã có phiếu/bài nộp, nhưng buổi phải nằm trong kế hoạch GV đã xác nhận. |
| Nhiều GV | Khi người khác đã sửa, từ chối ghi đè; giữ bản đang gõ và cho đọc bản hiện hành trước khi lưu lại. |
| Mất phản hồi | Gửi lại cùng mã thao tác để đọc kết quả đã lưu, không tăng thêm phiên bản. |
| Ẩn | Học viên không nhận nội dung đã ẩn; GV vẫn đọc được lịch sử. Để trống ô nhập không phải lệnh xóa. |
| Nháp | Giữ theo tài khoản/lớp/học viên/buổi trong tab hiện tại; đóng popup và tải lại vẫn còn. Đăng xuất xóa nháp của tài khoản đó. Không đồng bộ nháp chưa gửi sang thiết bị khác. |
| Làm mới | Học viên đọc lại riêng nhận xét mỗi 30 giây khi tab đang mở; tạm ngừng khi tab ẩn. Danh sách theo dõi GV nhận nhận xét cùng lượt đọc bản nháp 8 giây. |

## 2. Giao diện đã ghép vào source chính

- Thẻ học viên có nền và viền; bấm vùng thông tin/khoảng trống hoặc Enter/Space để mở bài. Chọn văn bản không mở bài; nút con có thao tác riêng.
- Hành trình riêng nằm cạnh tên. Nhận xét/Thêm nhận xét thay vị trí Xem bài nộp, cùng kiểu chữ, nền, viền và chiều cao với Điều chỉnh.
- Nhận xét hiện trong hộp xanh nhạt có viền và bóng nhẹ trên danh sách, ma trận, thẻ buổi và chi tiết.
- Hai phần phân tích mặc định đóng; cả vùng tiêu đề bấm được, dấu cộng/trừ đỏ giống Theo dõi lớp.
- Ma trận giữ trạng thái nộp và bỏ dòng Portal phụ. Dữ liệu Portal và luồng đồng bộ vẫn còn.
- Popup đóng bằng nút Đóng, ESC hoặc bấm ngoài; nháp vẫn được giữ. Sự kiện đóng cũ không hủy lần mở lại ngay sau đó.
- Lời nhắn mới nhất hiện ngoài vùng timeline đang thu gọn. Bộ lọc Buổi có nhận xét giữ lựa chọn khi đồng hồ hoặc dữ liệu được làm mới.
- Buổi chỉ có nhận xét mở nội dung nhận xét; không giả lập bài đã nộp và không trả đáp án của bài đang làm.

## 3. Dữ liệu và quyền

Migration bổ sung cột mã link được mã hóa, bảng mã thao tác link, bảng nhận xét hiện hành và bảng lịch sử. Không xóa/đổi bài nộp hay sự kiện điểm danh. Bảng lịch sử chỉ cấp SELECT/INSERT cho role API; không cấp sửa/xóa.

Nhận xét và link dùng ID lớp, ID học viên và số buổi; không nối theo tên. GV phải có quyền lớp và học viên phải thuộc roster hiện hành hoặc lịch sử có nguồn. Đọc lịch sử nhận xét vẫn kiểm quyền. API học viên xác định lớp/người từ mã link, mã lượt làm hoặc phiếu + người đã chọn; không nhận lớp do client tự khai để đổi phạm vi.

Link lưu bản mã AES-256-GCM với phiên bản khóa, gắn với ID link/lớp/người và kiểm hash khi giải mã. Không lưu mã link thô vào PostgreSQL, localStorage hoặc log. Khóa phải giữ ngoài Git và sao lưu cùng phương án phục hồi dữ liệu. Mất khóa không tự thay link.

API học viên chỉ trả nội dung nhận xét đang hiển thị, tên GV và thời gian; không trả email, lịch sử hoặc metadata thao tác. Nội dung được dựng bằng textContent, không thực thi HTML từ ô nhận xét.

## 4. Hợp đồng API

Các đường dưới nằm sau `/api/learning`. API mới trả Cache-Control: no-store.

| Đường | Dữ liệu nhận | Kết quả |
|---|---|---|
| POST /teacher/student-progress-links/resolve | classId, studentRef, operationId | Link đang dùng; chỉ tạo lần đầu khi chưa có lịch sử link. |
| POST /teacher/student-progress-links/rotate | Như trên + expectedAccessId | Thay link đúng phiên bản đã xem. |
| POST /teacher/student-progress-links/revoke | Như trên + expectedAccessId | Thu hồi đúng link đã xem. |
| PUT /teacher/session-comments | classId, studentRef, sessionNumber, noteText, expectedRevision, operationId | Nhận xét sau khi ghi và đọc lại. |
| POST /teacher/session-comments/hide | Target + expectedRevision + operationId | Phiên bản đã ẩn. |
| GET /teacher/session-comments/history | classId, studentRef, sessionNumber | Lịch sử mới nhất trước, dành cho GV. |
| POST /student/session-comments | accessToken; hoặc attemptToken; hoặc publicToken + studentRef + identityConfirmed | Một lượt đọc các nhận xét được công bố của đúng người/lớp. |

API tạo link kiểu cũ trả 409 với mã PROGRESS_LINK_CLIENT_UPGRADE_REQUIRED. Tải lại giao diện để dùng endpoint mới; không vô hiệu hóa link đã gửi. Có fixture legacy để kiểm bản thử được đặt lại vẫn thu hồi đúng link cũ.

Các thao tác ghi dùng khóa transaction theo target và mã thao tác, kiểm revision/ID đã xem, ghi và đọc lại trước khi trả thành công. Khi mã thao tác được dùng cho nội dung/target khác, trả conflict. Rút ngắn kế hoạch không được làm mất buổi đã có nhận xét, kể cả đang ẩn.

## 5. Cấu hình phát hành

| Tên | Ý nghĩa |
|---|---|
| LEARNING_JOURNEY_COMMENTS_ENABLED | Bật tính năng; mặc định false để API cũ vẫn chạy khi chưa migration/cấp khóa. |
| LEARNING_PROGRESS_LINK_KEYS | JSON các phiên bản khóa 32 byte được mã hóa base64. Cấp qua cấu hình riêng tư; không đưa vào source/Pages/log. |
| LEARNING_PROGRESS_LINK_KEY_VERSION | Phiên bản dùng để mã hóa link mới, mặc định v1. Giữ khóa cũ khi đổi phiên bản. |

Runtime live đã đọc: Node 24.19.0, PostgreSQL 16.14; role learning_service_login có quyền đọc roster/membership và ghi link. Migration dùng role learning_api theo các migration hiện hành; sau áp dụng phải kiểm lại quyền bằng đúng login runtime.

## 6. Thứ tự đưa lên hệ thống thật

1. Đọc lại image/source/config và phiên bản DB hiện hành; đối chiếu với ứng viên. Nếu runtime đổi, ghép lại trước khi chuyển.
2. Sao lưu riêng tư DB, image và cấu hình/khóa. Chuẩn bị ứng viên tắt tính năng nhưng vẫn hiểu hạn NULL để quay lui.
3. Áp dụng migration bổ sung trong transaction; kiểm bảng/cột/quyền role, chưa sửa hạn của link cũ.
4. Dựng API từ đúng image đang chạy, chỉ thay sáu module của overlay đã ghép. Giữ nguyên các module khác, dependencies, lịch lớp, hạn nộp và cấu hình hiện hành.
5. Kiểm API với tính năng tắt rồi bật + khóa riêng tư; kiểm health, auth, hạn nộp, trạng thái phần và queue Portal.
6. Chỉ khi mọi instance API hiểu hạn NULL: chuyển link active còn hiệu lực sang không hết hạn. Không đổi hash, không tạo lại, không kích hoạt link revoked/expired. Đọc lại số lượng/trạng thái/hash và lưu biên nhận riêng tư.
7. Phát Pages đúng revision. Các module/CSS thay đổi có mã revision mới để tránh dùng asset cũ trong cache.
8. Pilot đúng người/buổi được phép: lấy link → mở/reload ở trình duyệt khác → lưu/sửa/ẩn → đọc lại. Không tự gửi link hoặc thông báo hàng loạt.
9. Đọc lại hàng chờ và outcome Portal của một ca nghiệp vụ mới hợp lệ. Không dùng job complete cũ làm bằng chứng cho bản API vừa chuyển.

Không sửa n8n, không đổi thời hạn phiên GV 90 ngày nhàn rỗi/trần 365 ngày, không đổi nơi gửi điểm danh. Trước/sau chuyển API phải đối chiếu sự hiện diện/đích của LEARNING_ENABLED, LEARNING_DATABASE_URL, LEARNING_ATTENDANCE_SYNC_URL, ERP_SYNC_SECRET và consumer sync_portal_attendance. Không in giá trị bí mật.

## 7. Quay lui

Tắt tính năng và chuyển Pages/API về ứng viên tương thích hạn NULL đã chuẩn bị. Giữ bảng/cột/nhận xét/lịch sử/khóa. Không DROP, không tự hoàn nguyên thao tác thay/thu hồi link đã được GV xác nhận. Không quay mù về image cũ không hiểu NULL. Điểm danh ở Portal là dữ liệu ngoài hệ thống, không tự đảo theo rollback code.

Dừng chuyển tiếp khi sai người/buổi, mất quyền, thay link ngầm, mất khóa, mất readback, mất cấu hình/consumer điểm danh hoặc phiên GV sai. Giữ bài đã nhận và nhận xét đã lưu.

## 8. Cách kiểm bản source

- Bộ backend hiện hành: node --test --test-concurrency=2 test/*.test.js; bao gồm các luồng API dùng chung và điểm danh.
- Native Chrome + SQL fixture: đặt PAGES_SOURCE_ROOT vào đúng worktree Pages; chạy test/learning-journey-comments.browser.mjs. Đây là source sản phẩm, không phải HTML decorator demo.
- PostgreSQL thật: test/learning-journey-comments.postgres.mjs chỉ nối 127.0.0.1:54107, tạo database mới có tiền tố journey_fixture_. Không nhận URL production. Có kiểm nhiều kết nối, retry, stale, khóa kế hoạch, quyền lịch sử và tải 20 người × 31 buổi.
- Pages: chạy các progress-log test bằng dữ liệu giả. progress-log-live-smoke.cjs cần URL production được cấp riêng; progress-log-session3-ui.cjs là kịch bản trình duyệt cần runner, không coi chạy file không gọi hàm là đã kiểm UI.
- Kiểm ảnh 390/768/1440 px và đối chiếu trước/sau số attempt, submission, attendance_event, outbox_job.

Lệnh kiểm nhận source/fixture đúng revision, tạo báo cáo đạt/lỗi; khi lỗi giữ log và draft. Kết quả ở môi trường thử không thay thế readback sau phát hành thật. Báo riêng source đã kiểm, API/DB đã chuyển hay chưa, Pages đã phát hay chưa và Portal đã có ca mới xác minh hay chưa.

## 9. Trạng thái bàn giao

Source ở hai worktree riêng của task progress-journey-comments-20261007; có migration, test, ứng viên ghép trên live và ảnh native. Chưa coi các bước ghi DB/chuyển API/pilot thật là đã hoàn tất khi chưa có biên nhận production. Báo cáo kết quả kiểm và quyền phát hành được ghi riêng trong artifact của task, không thay đổi DECISIONS.md.

Kết quả kiểm trước phát hành: backend hiện hành 333/333; Pages 63/63. Gói ghép sáu module vào 59 module live đạt 18/18 ca tính năng trên SQL/Chrome/PostgreSQL, cùng 1/1 ca giữ phiên GV; không cộng các nhóm này thành số ca độc lập vì có kiểm lại phần giao nhau. Sau chỉnh xử lý conflict link, ca Chrome đã kiểm retry đọc link hiện hành và không thay link lần nữa; kiểm tĩnh Pages đạt 9/9.

Fixture của gói ghép dùng cấu trúc hai bảng Portal và cột result_json của outbox đã đọc từ live. Các trigger audit thuộc schema collaboration không chạy trong fixture riêng này; đây là giới hạn của kiểm local. Chưa có bằng chứng migration, quyền runtime sau migration, container/image mới, dữ liệu lớp thật hoặc ca Portal mới sau phát hành.
