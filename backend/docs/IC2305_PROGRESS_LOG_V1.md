# Progress Log IC2305 · Reading 1 & Listening 1

## Người dùng sẽ làm gì

### Học viên

1. Mở một link của lớp, chọn và xác nhận đúng tên.
2. Hoàn thành ba phần, tổng cộng tám câu trong khoảng năm phút.
3. Các câu 5, 6 và 8 hiện thành một câu có lần lượt 2, 3 và 2 ô đánh số.
4. Nội dung được lưu trên máy ngay và tự gửi bản nháp lên máy chủ sau một khoảng trễ ngắn.
5. Chỉ khi điền đủ trường bắt buộc và bấm **Nộp phiếu & điểm danh**, hệ thống mới xác nhận tham gia.

### Giảng viên

1. Đăng nhập Google và chọn đúng phiếu của IC2305.
2. Mở phiếu học viên hoặc sao chép link ngay trong dashboard.
3. Xem số học viên đã nộp đủ, nộp thiếu, chưa nộp.
4. Với học viên đang làm, bấm **Xem đang gõ** để đọc snapshot gần nhất đã autosave; đây không phải theo dõi từng phím gõ.
5. Có thể mở, khóa hoặc đóng từng phần và điều chỉnh điểm danh với lý do được lưu audit.

## Contract nội dung

| Câu | Dạng hiển thị | Xử lý |
| --- | --- | --- |
| 1–2 | Ô viết dài | Ghi nhận evidence, không chấm đúng sai |
| 3–4 | Chọn một | Chấm tự động bằng đáp án riêng tư |
| 5 | Hai ô đánh số | Bắt buộc điền đủ hai ô, không tự chấm khi chưa có rubric được duyệt |
| 6 | Ba ô đánh số | Bắt buộc điền đủ ba ô, không tự chấm khi chưa có rubric được duyệt |
| 7 | Đúng/Sai | Chấm tự động bằng đáp án riêng tư |
| 8 | Hai ô đánh số | Bắt buộc điền đủ hai ô, không tự chấm khi chưa có rubric được duyệt |

Đáp án câu khách quan chỉ nằm trong `FormGradingKeyV1` ở backend. `FormDefinitionV1`, GitHub Pages, API học viên và Markdown evidence không chứa đáp án chuẩn.

## Cách chuẩn bị phát hành

Lệnh dưới đây mặc định chỉ in kế hoạch, không ghi database:

```powershell
node scripts/publish-ic2305-progress-log.mjs --class=IC2305 --session=2
```

Khóa 56 có thể dùng một người tạo và duyệt khi tài khoản đó đã được cấp quyền `course_lead` cho đúng mã khóa. Ngoại lệ này không áp dụng sang khóa khác. Vận hành cấp quyền một lần bằng lệnh có audit reference; output chỉ in hash ngắn của email:

```powershell
$env:LEARNING_DATABASE_URL = '<kết nối do vận hành cấp>'
node scripts/grant-learning-course-lead.mjs --apply --course=56 --email=<email-lead-khối-56> --grant-reference="Chủ hệ thống xác nhận lead khối 56 ngày 2026-09-16"
```

Sau khi readback quyền thành công, phát hành bằng cùng email ở vai trò tạo và duyệt:

```powershell
$env:LEARNING_DATABASE_URL = '<kết nối do vận hành cấp>'
node scripts/publish-ic2305-progress-log.mjs --apply --class=IC2305 --session=2 --creator=<email-lead-khối-56> --approver=<email-lead-khối-56>
```

Script chạy trong một transaction, không in tên học viên, không ghi trùng assignment khi chạy lại, và readback hash/version/roster trước khi báo thành công.

## Ma trận kiểm thử bắt buộc

### Nội dung và chấm

- Đúng ba phần, tám câu, thứ tự 1–8 và thời lượng năm phút.
- Câu 3/4/7 đúng, sai và bỏ trống đều cho verdict đúng contract.
- Đáp án chuẩn không xuất hiện trong public definition hoặc kết quả học viên khi policy là `hidden`.
- Câu 5/6/8 thiếu một ô không được coi là hoàn tất; mảng sai số ô bị từ chối.
- Mảng được gửi vào câu text thường bị từ chối để tránh lệch loại dữ liệu.

### Lưu và nộp

- Refresh khôi phục draft mới nhất của đúng học viên.
- Draft revision cũ đến muộn không ghi đè revision mới.
- Hai tab hoặc mạng retry không tạo hai submission/điểm danh.
- Mất mạng giữ nội dung trong tab và không báo đã điểm danh khi máy chủ chưa xác nhận.
- Checkpoint hoàn tất không tự động điểm danh; chỉ final submit mới quyết định attendance.

### Dashboard và quyền riêng tư

- GV chỉ xem assignment thuộc lớp được cấp quyền.
- Live endpoint trả `assignmentId`, `studentRef`, `attemptId`, `draftRevision`; không trả attempt token hoặc grading key.
- Khi đổi assignment trong lúc request cũ còn chạy, kết quả cũ bị bỏ qua.
- Tab ẩn dừng polling; dashboard chỉ lấy snapshot mỗi tám giây.
- Hai học viên trùng tên vẫn gắn dữ liệu theo `studentRef`, không theo tên hiển thị.

### Trình duyệt và tải

- Desktop và màn hình 390 × 844 không tràn ngang, nút nộp vẫn dùng được.
- Unicode tiếng Việt, dấu ngoặc kép và văn bản dài hiển thị đúng.
- Nội dung học viên chỉ đi qua `textContent`/DOM an toàn; không dùng `innerHTML`, `eval` hoặc HTML tự do.
- Chạy lại benchmark 1.000 autosave và 1.000 submit/60 giây trên staging trước khi mở rộng ngoài pilot.

## Cổng trước production

- Đã xác nhận **Reading 1 & Listening 1 là buổi số 2** trong IC2305.
- Xác nhận lead khối 56 đã có quyền tự duyệt form có điểm trong `learning.course_content_authority`; khóa khác vẫn cần người duyệt độc lập.
- Kiểm roster chỉ bằng số lượng và readback; không chụp hoặc đưa tên học viên vào fixture/tài liệu.
- Backup database, chạy plan, staging smoke test, rồi mới xin phê duyệt ghi production và phát link thật.
