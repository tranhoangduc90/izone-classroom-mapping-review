# Listening Buổi 10 — link chung và Homework riêng

Trạng thái gói: đã kiểm cục bộ, danh tính Mapping thật và hai Google Docs demo thật với hồ sơ IC2304; chưa tích hợp Git hoặc phát hành VPS/Pages. Chưa ghi Homework đang giao hoặc tạo bài Classroom.

Bài mới là Inclusive design, Cambridge 20 Test 3 Part 4, Q31–40. Mã riêng `67-practice-listening_c20_t3_p4_inclusive_design`; phiên bản nội dung `c20-t3-p4-inclusive-design-20261022-v2`. Đề, key, transcript, audio và review giữ trong gói riêng tư ngoài Git.

## Hành trình

Cùng một URL có tham số `lesson` bằng mã bài. Học viên chọn lớp/tên trong nguồn quyền hiện hành; đăng nhập không tự bắt đầu hoặc tải audio. UUID, lớp, bài và phiên bản giữ lượt làm riêng. Link cá nhân của Buổi 8 không đổi.

Bắt đầu/reset/nộp lưu bài và job Docs cùng giao dịch. Worker Listening tìm bản Homework đúng số buổi từ metadata: UUID → Google user/course → Homework/BTVN → submission → bản sao Docs → tab có đúng mã. Không tìm theo tên người. Đích thiếu/trùng/sai hoặc bị sửa tay được giữ để kiểm, không ghi sang buổi khác. Google lỗi không làm mất bài hoặc đổi điểm.

Chỉ quản lý dòng “Listening thực chiến (tự động): …”; giữ chữ/link tay. Link GV lấy đúng submission của lượt đã nộp. Worker đọc lại sau ghi; job pending không phải Docs đã cập nhật hoặc Classroom đã nộp.

Khi chưa giao Homework đúng mã, job giữ pending và đối chiếu lại mỗi 5 phút, kể cả sau tám lần. Khi bản sao cá nhân xuất hiện, worker ghi tuần tự các sự kiện đã lưu mà không tạo lại lượt hoặc đổi điểm. Đích trùng/sai/người khác vẫn dừng để kiểm. Ca hồi quy đã tái hiện blocked ở lần thứ tám trước sửa; sau sửa chờ mười lần rồi ghi và đọc lại đúng Docs ở lần thứ mười một.

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

## Kiểm thêm bằng nguồn thật ngày 22/10

Theo lựa chọn của Đức, chưa giao Homework mới; chỉ tạo hai Docs demo riêng và giữ nguyên Homework đang dùng. Đã đối chiếu Mapping thật cho 15 hồ sơ hợp lệ của IC2304; hồ sơ còn lại ở trạng thái bảo lưu nên nguồn nhận diện trả missing và nguồn chủ Homework trả 403. Không tự sửa trạng thái học viên. Đã đọc đúng bốn Docs Homework Lesson 8/9 của hai hồ sơ theo Google user/submission/bản sao.

Browser cô lập chạy mã Buổi 10 với Mapping thật, API/SQL trên máy và adapter đích demo được chỉ định rõ. Đã kiểm tự nhớ/tự vào/Đổi người/hai tab; worker ghi và đọc lại 6 sự kiện trên hai Google Docs demo. Chữ/link nhập tay giữ nguyên, link GV đúng submission trong SQL local, retry nền không nhân dòng. Adapter demo không chứng minh tự tìm Homework Lesson 10 từ Classroom; đích đó vẫn chưa tồn tại.

Đã chạy trọn audio 486,322 giây ở 1× và hai phút rà rồi tự thu trên shared v2. Mười clip của v2 đã thực phát và tự dừng; đã kiểm đổi câu/đóng popup dừng đoạn cũ. Môi trường headless không chuyển trang sang hidden khi đổi tab, nên nhánh visibility thực tế vẫn chưa kiểm chứng. Không gọi đó là lỗi đã xác minh hoặc là đã đạt. Phiên GV dùng fixture để xem nháp/kết quả; chưa đăng nhập Google GV thật.

Kho bằng chứng riêng: `E:/Codex-Data/artifacts/listening-inclusive-design-20261022/real-students/`. Chỉ mục `REAL-CHECK.md`; không đưa danh tính, UUID, Doc ID, token, ảnh hoặc đề/key vào Git. Frontend đã sửa thông báo để phân biệt hồ sơ không đối chiếu được với trình duyệt chặn lưu; có regression RED/GREEN, 32 ca nhận diện và 35 unit liên quan đạt.

Audio 486,322 giây đã chạy trọn 1×, hai phút rà và tự thu; mười clip đã phát và tự dừng bằng player thật. Đây là kiểm kỹ thuật; chưa nghe duyệt trực tiếp bằng tai. Hai điểm nguồn Q32 được chỉnh trong bản web: giữ “problems” sau ô trống, key một từ “cognitive” và xác định đúng là tính từ. Docs nguồn không bị sửa.
