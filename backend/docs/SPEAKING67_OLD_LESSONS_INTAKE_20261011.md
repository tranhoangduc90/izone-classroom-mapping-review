# Mở Homework Speaking 67 Lesson 2–5 trên web

Đức yêu cầu ngày 11/10/2026 sửa phần hoạt động đã hoãn của các bài trước Lesson 6, rồi áp dụng giao diện mới cho Lesson 2–7. Quy tắc giữ nguyên đường cũ cho toàn bộ Lesson 2–5 ở mốc 08/10 là lịch sử; vẫn giữ nguyên bài và biên nhận đã có.

## Hành vi

- Catalogue active Lesson 2–7 và hồ sơ lớp hợp lệ có thể nhận bài web, không bắt có assignment/Docs trước.
- Ngưỡng, phần học và trạng thái của assignment cũ được kế thừa. Bài đóng/nháp không được mở lượt mới. IC2304 Lesson 4 giữ Freestyle một câu, không đổi mẫu ba câu của lớp khác.
- `speaking-legacy-bridge.js` ưu tiên đúng bài đã có tiến độ hoặc đúng Docs sẵn sàng. API độc lập trả phiên `intakeMode: legacy`; Pages gửi tiếp tới API cũ. Không sao chép bài sang schema mới.
- Bài web đã mở giữ cùng phiên khi Docs cũ xuất hiện sau. Nguồn Classroom mới được chuyển sang dịch vụ độc lập; assignment đã đăng ký giữ nguồn và ID cũ. Nhiều đích/tiến độ hoặc Docs chưa đối soát được phải báo lỗi, không chọn bản đầu hoặc tạo bài trắng thay thế.
- Hai route cầu nối chỉ ở sau xác thực secret worker. Mỗi lần mở/nộp vẫn kiểm hồ sơ đang học; nguồn lớp và trạng thái backend quyết định quyền.

## Source và phát hành

Các module `speaking-independent*.js` và migration 08/10 được phục hồi từ source live/Git đã giữ lại, vì main backend chưa có đầy đủ gói đang chạy. Migration này đã áp dụng ở production trước task; không chạy lại như một migration mới của ngày 11/10.

Bản phát hành ngày 11/10 kế thừa đúng hai image live. Chỉ thay router Speaking, nguồn catalogue và cầu nối lịch sử trên API chung; thay dịch vụ và HTTP server trên Speaking độc lập. Không build lại các sản phẩm khác từ main, không sửa n8n, template hoặc assignment có lịch sử.

Giữ đầy đủ Env, User, Healthcheck, mạng, mount, quyền/phiên giảng viên và cấu hình điểm danh. Source toàn image được đối chiếu bằng hash; dùng image/container cũ để quay lại, giữ dữ liệu và receipt mới. Image nền có nhiều lớp; việc đóng gói một lớp từ root filesystem live không được thay thế cấu hình container gốc.

## Kiểm chứng

Gói test mới có ca catalogue Lesson 2–5 mở không Classroom, ngưỡng riêng, giữ tiến độ/Docs cũ, xung đột, người nghỉ học, xác thực route, nguồn Classroom đến sau và phiên web ổn định. Năm ca mở bài cũ/ngưỡng riêng lỗi trên source live cũ và đạt trên bản sửa. Kiểm SQL cầu nối trên schema PostgreSQL qua PGlite; suite độc lập còn được chạy trong database PostgreSQL fixture riêng nhiều connection.

Source/tests và image/cấu hình đạt không chứng minh AI đã chấm bài học viên thật hoặc đã ghi Docs/Portal mới. Kết quả vận hành được báo riêng và cần readback đúng đích.
