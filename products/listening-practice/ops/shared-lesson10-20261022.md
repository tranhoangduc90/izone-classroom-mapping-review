# Listening Buổi 10 — link chung và Homework riêng

Trạng thái gói: đã kiểm cục bộ; chưa tích hợp Git, phát hành VPS hoặc ghi Google Docs thật.

Bài mới là Inclusive design, Cambridge 20 Test 3 Part 4, Q31–40. Mã riêng `67-practice-listening_c20_t3_p4_inclusive_design`; phiên bản nội dung `c20-t3-p4-inclusive-design-20261022-v2`. Đề, key, transcript, audio và review giữ trong gói riêng tư ngoài Git.

## Hành trình

Cùng một URL có tham số `lesson` bằng mã bài. Học viên chọn lớp/tên trong nguồn quyền hiện hành; đăng nhập không tự bắt đầu hoặc tải audio. UUID, lớp, bài và phiên bản giữ lượt làm riêng. Link cá nhân của Buổi 8 không đổi.

Bắt đầu/reset/nộp lưu bài và job Docs cùng giao dịch. Worker Listening tìm bản Homework đúng số buổi từ metadata: UUID → Google user/course → Homework/BTVN → submission → bản sao Docs → tab có đúng mã. Không tìm theo tên người. Đích thiếu/trùng/sai hoặc bị sửa tay được giữ để kiểm, không ghi sang buổi khác. Google lỗi không làm mất bài hoặc đổi điểm.

Chỉ quản lý dòng “Listening thực chiến (tự động): …”; giữ chữ/link tay. Link GV lấy đúng submission của lượt đã nộp. Worker đọc lại sau ghi; job pending không phải Docs đã cập nhật hoặc Classroom đã nộp.

## Đưa gói lên hệ thống thật khi đã có quyền

1. Đọc runtime/container đang chạy, backup image/cấu hình/DB Listening và hash audio Buổi 8. Giữ overlay đăng nhập/giảng viên/cache hiện hành.
2. Chạy migration 004-authored-time và 005-shared-entry trong DB Listening bằng owner sau backup. Không đổi DB/role/runtime Reading, Term hoặc Progress Log.
3. Nạp bundle riêng tư qua seeder gốc; thêm media catalog Listening đúng hash và review, giữ audio/review Buổi 8. Build và canary riêng Listening rồi mới chuyển service Listening.
4. Mở shared lesson đúng code/version bằng API quản trị; không tự thay phiên bản của link đã ghim. Phát frontend Pages sau backend.
5. Đọc lại URL/code/version/hash; kiểm quyền, chưa nộp không có key/review, player và hai tài khoản. Kiểm riêng consumer Buổi 8.
6. Đối chiếu Homework thật trước nối CTA hoặc chạy bù. Khi kiểm ngày 22/10/2026, IC2304 chưa có Homework Lesson 10; không tạo Classroom hoặc ghi Buổi 9 để thay thế. Workflow CTA legacy chỉ hỗ trợ mã đã phát hành: không coi catalog app là bằng chứng workflow đã hỗ trợ mã mới.

## Quay lại và giới hạn

Đóng link chung mới trước khi quay lại frontend/image đã backup; giữ schema bổ sung, bài làm và hàng Docs. Không restore dump đè bài phát sinh. Bài Buổi 8 giữ file/hash/binding/version cũ.

Backend dùng SQL/PGlite cục bộ và fixture Google/roster để kiểm, không phải kết quả Google thật. Bản ứng viên không import runtime/DB Reading; các đoạn mã link chung được kế thừa từ nguồn Reading ghim `67ecdf99c034746f0261535388392c2a91473652`, rồi chuyển sang namespace Listening và kiểm lại.

Audio 486,322 giây đã chạy trọn 1×, hai phút rà và tự thu; mười clip đã phát và tự dừng bằng player thật. Đây là kiểm kỹ thuật; chưa nghe duyệt trực tiếp bằng tai. Hai điểm nguồn Q32 được chỉnh trong bản web: giữ “problems” sau ô trống, key một từ “cognitive” và xác định đúng là tính từ. Docs nguồn không bị sửa.
