# Reading thực chiến khóa 67

Sản phẩm riêng cho bài luyện Reading. Buổi 7 giữ giao diện demo đã duyệt ngày 12/10/2026: 13 câu, 20 phút đang làm, Headings/MCQ/Summary, highlight/note, một phần Đáp án và giải thích với nút mở ngay dưới mỗi hàng.

## Thêm bài buổi 9 — 17/10/2026

Hỗ trợ thêm `67-practice-reading_matching_names_sentence_endings_mcq`: câu 27–40, Names/Endings/MCQ theo nhóm 7/3/4, vẫn 20 phút đang làm. `src/lessons.js` chỉ chứa nhãn và cấu trúc; gói đề, key, lời giải có màu và vị trí dẫn chứng được nạp riêng tư, theo version bất biến. Không đặt nội dung Cambridge hoặc key thật trong Git.

Đăng ký bản sao gửi thêm `code`; bỏ trường này vẫn chọn mã buổi 7 để tương thích công cụ cũ. Binding quyết định phạm vi nháp, cách chấm và mã cần thấy trong Docs; không tin mã bài từ giao diện. Metadata được cấp trước bắt đầu, không cấp passage/key/lời giải. Câu 40 và các tab mới chỉ hợp lệ với bài buổi 9.

Đã giữ phần đăng nhập giảng viên từ commit `930dc7bbce208bc04d0574be3d4dc84fd745c50f`, đối chiếu runtime Reading 15/10. Cookie ghi nhớ 90 ngày, trần 365 ngày; đăng xuất thu hồi phiên. `db/003-teacher-session.sql` là migration đã có của tính năng này, không phải yêu cầu đổi schema do bài buổi 9. Khi phát hành phải giữ cấu hình, dữ liệu và phiên hiện hành; không dựng lại từ bản source thiếu tính năng này.

Bản xây cục bộ không tự đăng ký Homework, mở lớp hoặc thay production. Preview nhận thư mục Pages gốc hoặc thư mục `reading-practice`; Google/roster/owner trong preview là fixture, API và SQL bài làm là code thật.

## Phạm vi và nguồn

- Plan nghiệp vụ: `E:/Codex-Data/artifacts/reading-practice-buoi7-20261011/KE-HOACH.md`.
- Demo chốt: `E:/Codex-Data/artifacts/reading-practice-buoi7-demo-20261012/DEMO.html` và `unified-results-verification.json`.
- Giao diện Pages ở thư mục `reading-practice/` của repo Pages; chỉ có renderer và CSS/font đã ghim, không có đề/đáp án/lời giải hoặc học viên trong Git công khai.
- Nội dung nạp từ gói JSON riêng tư vào database; bản chuẩn không nằm trong source. Không tự mở bài cho lớp hoặc phát Homework hàng loạt.
- Source mới ở worktree từ backend `587cec77250cbb490236cc2524f8d0305f8732a5`, Pages `05a27ad544a9b77778a4c50d5ca65511947f9347`.

## Cách vận hành

### Link chung chọn lớp và tên — 17/10/2026

`reading-practice/?lesson=9` lấy tất cả lớp có học viên active/approved từ nguồn K67 hiện hành; bài không có danh sách lớp cho phép riêng. `GET /api/library/9` trả metadata/lớp, `GET /api/library/9/classes/:id` chỉ trả UUID/tên của lớp chọn; không trả passage/key/lời giải. `POST /api/shared-login` kiểm lại lớp và UUID, tạo một binding cho lớp/content/học viên; chỉ Bắt đầu mới tạo lượt. Chọn lớp/tên là cách nhận diện được chọn cho link chung. Không cần Homework Docs hoặc Google của học viên.

Chạy `db/004-shared-entry.sql` bằng role owner trước image mới. Migration thêm `shared_lesson`, cho phép binding không Docs chỉ khi có marker `owner_proof.mode=shared`, cấp quyền bảng mới cho role ứng dụng hiện hữu. Admin mở chung bằng `POST /api/admin/shared-lesson` với `{code,contentVersion,status:"open"}`; phiên bản được ghim bất biến. Đóng bài chặn đăng nhập mới/bắt đầu/reset, vẫn cho phiên hiện hữu đọc và tiếp tục. Không restore dump cũ đè lịch sử; image quay lui phải hiểu binding không Docs.

Lượt shared lưu kết quả trong Reading, không xếp hàng Google Docs; giảng viên xem link kết quả với quyền Google/lớp hiện có. Link Homework cũ vẫn kiểm owner/CTA và ghi Docs theo luồng cũ. Không sửa Classroom, nguồn context hoặc các sản phẩm khác. Preview thêm tham số cuối `shared` để kiểm hai lớp/người giả bằng cùng API/SQL.

Backend sở hữu danh tính theo bản Docs, lượt làm, giờ đã dùng, nháp, bài nộp và công việc ghi Docs. API ngữ cảnh K67 `/v1/snapshot` được dùng chỉ đọc theo hợp đồng v1; không truy cập bảng hoặc khởi động consumer của Term/Speaking. Các lớp có bài Reading được đăng ký riêng.

Chủ Docs được đối chiếu UUID → Google user/course qua cầu nguồn chỉ đọc v1, rồi so với đúng student submission và attachment Google Classroom. Đọc lại mã bài/tab trong Docs trước tạo binding. Nguồn mới chỉ có role/view riêng; chưa chạy migration hoặc thay runtime hiện hành trên VPS. Classroom có thể chưa sinh bản `STUDENT_COPY` khi submission còn `NEW`; phải chờ bản sao thật, không thay bằng template.

`npm ci`, `npm test`; `npm start` cần cấu hình riêng và database đã chuẩn bị. Công cụ preview chạy PGlite trên máy, không dùng kho production. Xem `DESIGN.md` và `ops/` trước phát hành; chưa có quyền production thì chỉ xây/kiểm cục bộ.

Ở chế độ Homework, chọn lớp/tên chỉ mở phiên đúng chủ bản Docs. Người có link kết quả vẫn phải đăng nhập Google và có quyền lớp. Điểm và lời giải do máy chủ trả sau nộp; reset không xóa kết quả cũ.
