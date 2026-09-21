# Kế hoạch triển khai Progress Log IC2305 — Buổi 3

## Mục tiêu và phạm vi

Tạo phiếu `ENTRANCE TICKET • LISTENING 1 + SPEAKING 2` cho IC2305, buổi 3, trong ứng dụng Progress Log dùng chung. Phiếu có ba checkpoint do giảng viên chủ động mở: ôn Writing, Speaking và Listening. Dashboard hiện hành phải đọc được bản nháp, bài nộp, kết quả chấm khách quan và trạng thái điểm danh/Portal.

Không tạo website hoặc schema riêng, không đổi dữ liệu buổi 2/4, không ghi dữ liệu học viên thật, không migration hay phát hành production trong giai đoạn build này.

## Nguồn và quyết định đã khóa

- Nguồn nội dung: `E:/Entrance Ticket - Writing 2 (1).docx`; tiêu đề bên trong tài liệu là nguồn chuẩn.
- Câu ôn Writing chấm đáp án `B`.
- Ô giữa chuỗi lập luận chỉ kiểm tra có nội dung, không chấm đúng sai.
- Hai ý phân biệt 15 và 50 chỉ kiểm tra đã điền đủ hai ô.
- Câu ghi lại nhận xét của giáo viên không bắt buộc.
- Đáp án Listening khách quan: `C` và `B`; chính sách mở đáp án là `hidden`.
- Màn nộp xong của IC2305 không hiện khối “Việc tiếp theo”.

## Bản đồ file và trách nhiệm

| Thành phần | Trách nhiệm |
| --- | --- |
| `backend/src/learning-templates/ic2305-entrance-listening1-speaking2.js` | FormDefinitionV1 và grading key riêng tư của buổi 3 |
| `backend/src/learning-contracts.js` | Contract dùng chung cho số câu hiển thị, chuỗi lập luận và trường phụ thuộc |
| `backend/src/learning-domain.js` | Completeness của trường chỉ bắt buộc khi phương án “Khác” được chọn |
| `backend/scripts/publish-ic2305-progress-log.mjs` | Chọn đúng template buổi 3 ở chế độ plan/apply |
| `backend/test/learning-ic2305-session3-template.test.js` | Nội dung, chấm điểm, điều kiện bắt buộc và chống lộ đáp án |
| `progress-log/app.js` | Render chuỗi lập luận, câu phụ “Khác”, số câu theo từng phần và validation |
| `progress-log/styles.css` | Ngoại hình/responsive đúng visual contract |
| `progress-log/teacher.js` | Hiển thị câu theo số gốc và ẩn trường phụ không liên quan |
| `tests/progress-log-session3-static.mjs` | Regression tĩnh cho renderer, CSS, dashboard và nội dung bị cấm |

## Lát triển khai

1. **Contract và template**
   - Consumes: nội dung DOCX và bốn quyết định đã khóa.
   - Produces: definition công khai, grading key riêng tư, fixture hợp lệ.
   - Giữ: UUID bất biến, answer key không lọt public definition, câu không chấm không ảnh hưởng điểm danh.
2. **Renderer học viên**
   - Consumes: definition mới và contract chung.
   - Produces: ba checkpoint, chuỗi lập luận có ô giữa, lựa chọn “Khác” có ô phụ, mobile/desktop usable.
   - Giữ: một link, autosave revision, checkpoint không tự điểm danh, nộp cuối idempotent.
3. **Dashboard giảng viên**
   - Consumes: definition và live draft hiện hành.
   - Produces: cách đọc đúng số câu gốc, nội dung trường phụ chỉ khi có liên quan.
   - Giữ: Theo dõi lớp đứng trước, polling 8 giây, quyền backend và Portal async.
4. **Phát hành nội dung**
   - Consumes: template đã test và người có quyền khóa 56.
   - Produces: chế độ plan sẵn sàng; `--apply` chỉ dùng sau cổng production riêng.

## Review Focus

1. Chọn “Vấn đề khác” nhưng bỏ trống phần nêu rõ phải bị chặn; đổi sang lựa chọn khác phải bỏ yêu cầu này.
2. Số câu hiển thị phải khớp bản gốc dù position kỹ thuật là duy nhất toàn form.
3. Chuỗi lập luận phải đọc đủ trên 390/768/1440 px và không mất câu trả lời dài.
4. Answer key không được xuất hiện trong Pages, API public hoặc definition.
5. Thêm dạng hiển thị mới không làm hỏng buổi 2/4, autosave, checkpoint, dashboard hoặc ghi nhớ học viên.

## Kiểm chứng và rollback

- Focused backend: `node --test test/learning-ic2305-session3-template.test.js test/learning-domain.test.js` → exit 0, không skip.
- Focused Pages: `node --test tests/progress-log-session3-static.mjs tests/progress-log-static.mjs tests/progress-log-memory.cjs` → exit 0, không skip.
- Cú pháp: `npm run check` ở backend; `node --check` cho ba file JavaScript Pages.
- Full suite backend: `npm test` → exit 0, không skip.
- Full suite Pages: chạy toàn bộ `tests/progress-log-*.mjs/cjs` → exit 0, không skip.
- Trình duyệt cô lập: mock API bằng dữ liệu giả; kiểm 390/768/1440 px, bàn phím, đáp án dài, offline/retry và màn nộp xong.
- Revision bằng chứng: hash kết hợp của hai commit task sau khi mọi file đã ổn định.
- Rollback: revert commit task tương ứng; chưa có DB/production mutation nên không cần xóa assignment hay submission.
- Dừng ngay nếu phải migration schema, sửa API production, thay identity contract hoặc cần dữ liệu học viên thật.
