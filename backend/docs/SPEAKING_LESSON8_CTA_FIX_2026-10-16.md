# Sửa link Homework Speaking Lesson 8 — 16/10/2026

## Vấn đề và phạm vi

Nút Speaking của 15 bản Homework Lesson 8 IC2304 bị hệ thống gắn vào trang
Lesson 3, dù mã bài là `67-speaking-so_sanh`. Trang Lesson 3 từ chối cấu hình
ba phần của bài So sánh nên học viên không chọn được tên để mở bài.

Hàm `speakingCopyUrl` thiếu nhánh Lesson 8 và dùng Lesson 3 làm mặc định.
Hàm xác minh gọi lại cùng hàm tạo URL, vì vậy vẫn chấp nhận link sai.

Tuyến công khai đi qua API chung, nhưng `speaking-independent-source.forward`
được đăng ký trước các handler Classroom copies cũ và chuyển bài có nguồn mới
tới `speaking67-independent-api`. Module có lỗi tồn tại ở cả hai runtime.
Đọc hash source trong API chung chưa chứng minh endpoint thật đã được sửa;
phải kiểm response của `/internal/classroom-copies/plan` qua URL công khai.
Gói phát hành sửa cùng module trên hai image nền riêng, giữ cấu hình từng runtime.

## Thay đổi

- Bổ sung đường dẫn `lesson-8.html` cho đúng mã So sánh.
- Giữ nguyên đường dẫn và định danh của Lesson 2–7, lớp và từng bản Docs.
- Đưa vào source các nhánh Lesson 5–7 đã có trên production để bản lưu
  không làm mất các sửa đổi live đó khi được tích hợp sau này.
- Thêm regression có kỳ vọng URL độc lập cho đủ bảy mã bài Lesson 2–8;
  kiểm kế hoạch sửa, xác minh từ chối Lesson 3 sai và lần gọi lại không ghi.

Mã nhận Doc ID, lớp và mã bài, chọn đúng trang rồi giữ các định danh trong URL.
Nếu sai ánh xạ, test chỉ rõ mã bài và URL không khớp. Không thay cơ chế nhận bài,
ngưỡng luyện, AI, Bác sĩ AI, điểm danh, quyền hay phiên giảng viên.

## Bằng chứng và phát hành

- Trên base tương đương exact source live: sáu mã cũ đạt, Lesson 8 RED.
- Sau sửa: bảy mã đạt. Image ứng viên kiểm thêm phiên giảng viên 90/365 ngày.
- Image dùng exact image live làm nền, phủ một module ứng dụng và regression;
  toàn bộ hash source ngoài module này phải giữ nguyên.
- Sao chép config, Env, mount và network từ container live; chỉ BUILD_SHA đổi
  theo image. Giữ container cũ đã dừng để quay lại và không rollback database.
- Đọc lại đủ 15 hyperlink; đối chiếu nội dung/định dạng Docs trước và sau.
- Đã chuyển cả API chung và API Speaking độc lập; endpoint công khai lập kế
  hoạch cho 15/15 bản đúng trả `already_current`, không sinh request ghi lại.
- Catalogue Lesson 2–8 giữ nguyên, mỗi mã có 10 lớp. Bảy ca định tuyến đạt
  và mỗi image cuối đạt tám ca gồm định tuyến và phiên giảng viên.
- Bộ backend rộng có 395 ca đạt trong lần đầu; 21 ca PostgreSQL chạy riêng
  sau khi chuẩn bị fixture cho 19 đạt và hai lỗi kết nối ở S07/S08, S10.
  Không ghi toàn bộ suite đạt. Source Progress Log trong image trước/sau
  giữ nguyên; nguyên nhân hai lỗi fixture chưa được khép trong task Speaking.
- Hàng điểm danh trước/sau giữ 169 complete, 15 review_required và không
  có processing hết lease. Đây không phải bằng chứng lượt ghi Portal mới.
- Hồ sơ riêng tư và trạng thái phát hành thực tế ở
  `E:/Codex-Data/speaking-lesson8-link-investigation-20261016/`;
  bản ghi Git không chứa Doc ID, bài học viên, credential hoặc snapshot container.

## Quay lại

Giữ image nền và container `mapping-review-api-before-speaking8-link-20261016`
cùng `speaking67-independent-api-before-speaking8-link-20261016`.
Khi cần quay lại, đọc journal, dừng đúng candidate, khôi phục tên/mạng của
container gốc và khởi động lại; kiểm hash config/source và health.
Không xóa bài nộp, biên nhận, binding, hàng điểm danh hoặc các thay đổi của task khác.

Quyền phát hành production của gói này được Đức cấp trực tiếp trong chat.
Commit branch, tích hợp main và push là trạng thái riêng; tài liệu này không
tự chứng nhận một lần phát hành hoặc kết quả Portal mới.
