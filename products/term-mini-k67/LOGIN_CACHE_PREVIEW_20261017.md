# Bản thử mở lại Term Test 1 K67 nhanh hơn

Đây là gói mã để kiểm riêng, **chưa phát hành**. Nền backend `ad25b724924260c5de900fa3b8955bbaf7e5d621` khớp toàn bộ JavaScript của dịch vụ K67 đang chạy tại lúc bắt đầu. Cần ghép với nhánh Pages `codex/k67-login-cache-20261017-pages`; không dựng lại toàn bộ VPS từ repository này.

## Thay đổi

- Người có mã lượt hợp lệ mở lại Term 1 trên máy tính đi thẳng qua bước xác minh lượt, bỏ hai lần tải danh sách lớp. Người chỉ được nhớ tên vẫn xác nhận; phòng chờ và nút bắt đầu thi giữ nguyên.
- Danh sách Term 1 cùng lớp/bài đang được đọc chỉ thực hiện một công việc dùng chung. Khi xong hoặc lỗi, mục chờ bị bỏ; yêu cầu sau đọc nguồn mới.
- Kiểm độ mới của bản sao dùng chung công việc đang chờ, nhưng mỗi lượt sử dụng vẫn kiểm timestamp và hạn 120 giây. Trong cùng một yêu cầu mở bài, không hỏi lại timestamp hoặc học viên ở hai bộ xử lý nối tiếp.
- Nội dung đề gộp lần đọc đầu tiên, giữ nguyên cơ chế nhớ đề theo vòng đời dịch vụ. Không đổi cơ chế hash, tải hoặc phát audio.
- Khôi phục Term 1 giữ nháp Reading trên thiết bị nếu số phiên bản của nó mới hơn bản máy chủ đã nhận.

Cache nghĩa là dữ liệu được giữ để dùng lại; ở đây thông tin danh sách/quyền không được giữ thêm một khoảng thời gian sau khi yêu cầu đã xong. RAM là bộ nhớ của chương trình; PostgreSQL là phần mềm quản lý kho dữ liệu; API là cửa nhận yêu cầu của máy chủ. Không thêm Redis hoặc thư viện phụ thuộc.

## Phạm vi và kiểm chứng

Frontend tối ưu riêng Term 1 computer-based. K56, Substitute, đăng nhập Google của giảng viên và mã nguồn API chung giữ nguyên. Module kiểm ngữ cảnh và đọc tài nguyên vẫn dùng chung trong backend K67 nên bộ kiểm bao gồm Term 2/Mini và luồng làm quen.

- 293 ca logic trên Linux/PostgreSQL thật đạt, không bỏ qua ca trong nhóm đã chọn. Danh mục gồm 34 tệp; các bộ triển khai/fixture ngoài máy thử giữ ngoài phạm vi này. Không gọi đó là mọi bộ kiểm trong repository đã đạt.
- 100 học viên giả, bốn mạng riêng phân bố 30/30/30/10, API giới hạn 0,5 CPU và 256 MiB, năm kết nối database. Đọc lại đúng từng bài; không ghi/nộp/chấm trùng. Không gọi AI/Portal hoặc audio thật.
- Lượt so sánh cuối: lấy danh sách và chuẩn bị bài có P95 1,71 → 1,37 giây; riêng roster 0,57 → 0,39 giây. P95 là thời gian mà 95 trong 100 yêu cầu hoàn tất trong khoảng đó.
- Giao diện Chrome dùng API giả có độ trễ cố định: đường quay lại bài bỏ hai lần roster; số đo không đại diện mạng Internet hay điện thoại thật.
- Bộ hồi quy giao diện rộng đạt 174 ca, còn nhóm kết quả K56/Substitute vượt hạn thời gian và hủy chín ca con. Chưa tuyên bố toàn bộ suite giao diện đạt; các tệp của nhóm đó không được sửa trong gói. Chi tiết và log giữ trong báo cáo riêng.

Các bài kiểm mới: `test/login-reads.test.js` và `test/pending-reads.test.js`. Bộ kiểm giao diện mới: `tests/k67-login-restore-browser.mjs` trong repo Pages. Test nhận dữ liệu giả, gửi HTTP và đọc lại trạng thái; lỗi hiện bằng mã thoát khác 0 và log chi tiết. Bộ tải 100 dùng cấu trúc/đề production nhưng học viên, bài làm và mọi đích ghi đều giả trong mạng Linux chỉ có loopback.

[Báo cáo đầy đủ và log riêng trên máy Đức](E:/Codex-Data/k67-login-cache-20261017/KET_QUA_CHANG_1.md); không chép nội dung đề, bản chụp chương trình đang chạy hoặc tệp kết quả kiểm vào Git công khai.

## Khi chuẩn bị phát hành

Đối chiếu lại runtime hiện hành và kết quả hồi quy giao diện trước khi chọn gói. Triển khai frontend/backend là hai thao tác riêng; gói này chưa cấp quyền phát hành. Không thay database, đồng bộ ngữ cảnh, cấu hình điểm danh, Redis hoặc dịch vụ Substitute. Quay lại bằng mã cũ, giữ kho dữ liệu hiện tại có bài mới; không restore dump đè bài học viên.
