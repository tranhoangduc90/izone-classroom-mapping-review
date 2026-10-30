# Progress Log — Thẻ 20

Gói bổ sung cổng học viên chọn lớp/tên, đọc đủ Test hiện hành và mở từng Task Writing chỉ đọc qua quyền Journey. Không tạo/sửa/nộp lượt thi hoặc chấm AI; không đổi schema nghiệp vụ, điểm danh, phiên giảng viên hoặc điểm đã lưu.

## Nguồn Test cần nối khi phát hành

Reader cũ chỉ thấy `mapping_db.assessment` lịch sử. Bản mới hợp nhất lịch sử với K56 (`mapping_db.assessment_k56`) và K67 (`term_mini_k67.assessment`); dùng lớp + UUID/ERP ID chính xác, không nối bằng tên. Nguồn hiện hành thắng khi cùng mã bài và mới hơn. Bất kỳ nguồn nào lỗi thì báo chưa tải đủ; không nhận điểm lịch sử là toàn bộ điểm hiện hành.

Tạo role chỉ đọc riêng cho từng kho bằng [read-only-role.sql](read-only-role.sql), truyền mật khẩu mạnh qua kênh bí mật. Không dùng role ghi của hệ thống thi. Hai connection string đặt trong biến môi trường API thật:

- `LEARNING_TEST_K56_DATABASE_URL`
- `LEARNING_TEST_K67_DATABASE_URL`

Pool giới hạn hai kết nối mỗi kho, chờ kết nối tối đa 5 giây, SELECT tối đa 6 giây, phiên mặc định chỉ đọc. `server.js` dừng sớm nếu thiếu một nguồn. K56 phải truy cập được mạng của database mapping; K67 cần đường nội bộ tới `term-mini-k67-postgres` trên `n8n-net`. Chỉ nối container API Progress Log vào mạng cần thiết; giữ các mạng/cổng/volume/env cũ. Chưa có quyền phát hành thì chưa tạo role hoặc thay mạng/env/container.

Demo giữ kho PGlite riêng và không nối database bài thi thật. Chỉ phủ các module route/service cần cho giao diện thử; nguồn Test chưa nối phải hiển thị đúng trạng thái.

## Ghép lên image đang chạy

Không build lại API từ toàn bộ main. Lấy lại source + image/container ID, giữ snapshot riêng tư và so với baseline ngay trước khi thay. Bản ứng viên local đã ghép delta vào đúng source live:

- API thật: thay `app.js`, `config.js`, `server.js`, `learning-routes.js`, `learning-service.js`, `learning-test-results.js`; thêm `learning-student-portal.js`, `learning-test-current-sources.js`, `assessment-schema-pool.js`.
- Demo: chỉ thay `learning-routes.js`, `learning-service.js`, `learning-test-results.js`, thêm `learning-student-portal.js`.

Phải so toàn thư mục `src`: mọi file khác giữ hash. Giữ overlay hiện hành, worker điểm danh, SSO 90/365 ngày, điều phối Speaking, cấu hình timeout AI và các đích Portal. File source live, danh sách học viên, bài viết và credential không đưa vào Git.

## Kiểm và thứ tự phát hành

1. Kiểm SQL/HTTP Thẻ 20, test nguồn hiện hành, test kết quả Test và hồi quy Learning. Kiểm schema/quyền tối thiểu bằng role mới trước khi nhận lưu lượng.
2. Khởi động ứng viên trên cổng riêng bằng đúng cấu hình đã duyệt, đọc health/ready. Kiểm class/name, đúng UUID/lớp, Writing 0/Task 2/chưa chấm/cần kiểm tra, link bản cũ và nguồn mất kết nối; không giao bài hay nộp thay học viên.
3. API tương thích cũ phát hành trước Pages; chỉ sau đó mới hợp nhất frontend main vì GitHub Pages tự xuất bản. Dùng Chrome thật kiểm desktop/mobile, lưu/đăng xuất/quay lại, ba nhịp cập nhật nền và màn giảng viên.
4. Đối chiếu hash nguồn, số liệu bài/điểm trước/sau trong kho riêng; không coi health xanh là mọi chức năng đã đạt.
5. Giữ image/container/env/mạng cũ để quay code. Khi lỗi, trở lại API/Pages cũ và gỡ kết nối bổ sung khi an toàn. Không restore đè dữ liệu mới, sửa điểm hoặc thu hồi link học viên để rollback giao diện.

Giới hạn kiểm local: các ca PostgreSQL nhiều kết nối cần fixture riêng tại `127.0.0.1:16547/progress_log_fixture`; không được trỏ chúng vào database production. Kết quả và ca chưa chạy được phải ghi riêng, không báo full suite đạt khi thiếu fixture.
