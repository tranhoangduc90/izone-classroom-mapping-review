# Mở Homework Speaking bằng đường đọc Docs riêng

Khi mở bài từ Docs, học viên không phải đợi công việc AI hoặc chấm bài trong hàng n8n chung. Dịch vụ Speaking đọc Google Docs trực tiếp bằng tài khoản Google hiện đang phục vụ cầu nối. Nội dung thật vẫn phải đúng mã bài, tab và các mục bắt buộc trước khi cấp phiên.

## Bật và kiểm

- Source mới: `src/speaking-docs-read.js`; phần nối nằm trong `src/speaking-independent-server.js`.
- Cấu hình `SPEAKING_DOCS_READ_CREDENTIALS_FILE` trỏ tới file JSON riêng chứa `clientId`, `clientSecret`, `refreshToken`. File nằm ngoài image/Git và được gắn chỉ đọc vào container Speaking. Không ghi token vào log, trình duyệt hoặc hồ sơ phát hành công khai.
- Khóa Google cho phép máy chủ xin mã truy cập tạm thời (OAuth); mã tạm được giữ trong bộ nhớ đến trước hạn hết hiệu lực một phút. Mỗi lần mở vẫn đọc Docs mới, không giữ bản nội dung/quyền để dùng ở lượt sau. Các lượt cùng Docs đang chờ được gộp.
- Giới hạn mặc định: sáu lượt Google đồng thời, tối đa 30 Docs đang chờ, 7,5 giây cho toàn lượt đọc; thời gian lấy token tối đa ba giây. Khi nguồn chậm hoặc từ chối, hệ thống không cấp phiên từ nội dung cũ.
- `GET /health` trả `docsReadMode=direct` khi cấu hình đọc trực tiếp được bật. Kiểm thêm mở/khởi tạo phiên của Docs thử và đối chiếu đúng biên nhận; health không tự chứng minh kết quả nghiệp vụ.
- Chưa đặt cấu hình mới thì giữ tương thích gateway cũ. Khi cấu hình mới có nhưng file sai/hỏng, dịch vụ dừng khởi động bằng mã lỗi cố định, không âm thầm quay về hàng n8n.

## Những đường cần giữ

- Bộ ghi biên nhận vẫn dùng gateway cũ: đọc revision, ghi ô trạng thái rồi đọc lại. Mã mới chỉ thay đường đọc phục vụ mở bài và các thao tác đối soát Docs của dịch vụ độc lập.
- Không thay API nguồn chung, giới hạn thực thi n8n, quy tắc lớp/người học, checker AI, nguồn Classroom, trạng thái bài hoặc cơ chế một biên nhận.
- Các phiên legacy của Lesson 2–5 vẫn do nguồn legacy quyết định. Bản sửa này không di chuyển việc mở legacy sang Google reader mới; cần phân biệt với hồ sơ độc lập dùng chung dịch vụ.

## Khi có lỗi

- `DOC_READ_FORBIDDEN` / `DOC_READ_NOT_FOUND`: kiểm đúng file và quyền chia sẻ cho cùng tài khoản Google của cầu nối; không cấp quyền rộng hoặc chọn file khác để vượt lỗi.
- `DOC_READ_UNAVAILABLE`: kiểm cấu hình Google, thời gian đọc và hạn mức; không in body nguồn hoặc token. Google 401 chỉ được làm mới token và đọc lại một lần.
- `DOC_READ_BUSY`: chờ vài giây rồi mở lại; không tạo hàng công việc không giới hạn.
- Quay lui bằng image/cấu hình container trước đó và gỡ cấu hình đọc trực tiếp của bản mới. Giữ database, bài học viên và biên nhận phát sinh sau phát hành; không phục hồi dump cũ.

## Phạm vi kiểm bản sửa

Kiểm hàng n8n chậm 47/86 giây, đường đọc Google và đường ghi cũ tách biệt; token/lỗi quyền/ID/revision/tab; đồng thời/gộp lượt/deadline/phục hồi; các test Speaking native; canary Docs riêng trên tài khoản thật. Mẫu thử không chứng minh mọi giờ cao điểm hoặc việc đăng nhập/phân tích hội thoại của học viên thật đã được kiểm lại.

Hồ sơ điều tra, source live trước sửa, RED/GREEN và phép thử thật được giữ trong kho vận hành riêng của task ngày 19/10/2026, không đưa khóa hoặc bài học viên vào repository.
