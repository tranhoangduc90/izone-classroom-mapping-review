# Progress Log IC2304 khóa 67 buổi 3

## Phạm vi

Phần phát hành là `small_complete`: một phiếu buổi 3 cho lớp IC2304, màn học viên và dashboard hiện có, cùng một phiếu demo tách khỏi roster thật. Không đổi bài đã nộp của các buổi trước, không tự chấm Writing hoặc Speaking, không đưa đoạn đọc đầy đủ lên answer sheet.

Nguồn nội dung là `G:/My Drive/4 - IZONE/Các khóa giảng dạy/6-7/Handout/1665/Handout Lesson 3.pdf`, năm trang, đã đọc ngày 28/09/2026. Tài liệu `E:/2026.01 Giáo trình Reading 67 mới.docx` có hai đoạn A–B và mười heading. Đức đã xác nhận chỉ dùng A–B và khóa chấm trong hội thoại; đoạn C trong handout được bỏ. Khóa chỉ được nhập vào backend khi chạy lệnh xuất bản, không nằm trong Pages hay tài liệu Git.

| Nội dung | Cách học viên nhập | Bắt buộc | Chấm | Bằng chứng |
| --- | --- | --- | --- | --- |
| Reading, đoạn A–B | Hai dòng tên đoạn, mỗi dòng có dropdown cùng mười heading i–x | Có | Một điểm mỗi đoạn; hiện đúng/sai và heading đúng sau khi nộp phần | Response và grading item |
| Writing, Body 1: Idea 1, Idea 2, Topic sentence | Ba ô tự luận | Có | Không | Nguyên văn bài viết |
| Writing, Body 2: Idea 1, Idea 2, Topic sentence | Ba ô tự luận | Có | Không | Nguyên văn bài viết |
| Writing, Thesis statement của mở bài | Một ô tự luận cuối phần | Có | Không | Nguyên văn bài viết |
| Speaking | Checklist tám mục của IC2304 buổi 2, chọn tối đa hai; ô giải thích hiện có điều kiện | Theo luật của buổi 2 | Không | Lựa chọn và lời giải thích |

## Vận hành và kiểm

Học viên mở link, xác nhận tên, nộp từng phần rồi nộp cuối. API lưu checkpoint, trả chấm Reading, lưu bài cuối và xếp việc điểm danh Portal sau khi đủ trường bắt buộc. Phiếu demo dùng lớp giả hiện có, mã `DEMO-67`, sáu học viên giả có lượt nộp riêng và cả ba phần mở sẵn; backend loại đúng mã và lớp demo khỏi hàng chờ Portal.

Thiết kế tải kế thừa Progress Log hiện hành: tối thiểu 20 học viên nộp trong 60 giây theo ma trận nghiệm thu. Không thêm dịch vụ hoặc request nền mới; dropdown lưu cùng nhịp autosave của câu chọn đáp án. Nếu API chậm hoặc mất mạng, nháp ở tab vẫn giữ và học viên thử lại; checkpoint không tự điểm danh. Giảng viên xem trạng thái bài và Portal trong dashboard. Khi hàng chờ Portal lỗi, giữ receipt và điều tra theo runbook thay vì báo đã ghi Portal.

Trước phát hành: thử định nghĩa và bộ chấm, full suite backend, giao diện 390/768/1440 px với API giả, bảo vệ bộ nhớ chọn học viên và kiểm nguồn Pages không chứa grading key. Kiểm cấu hình và consumer điểm danh live trước khi đổi API. Backup database rồi mới ghi form/assignment; đọc lại phiên bản, lớp, roster, khóa chấm riêng và link demo. Sau phát hành đọc lại Pages/API và một lượt demo đến kết quả nhìn thấy; không dùng học viên thật làm fixture.

Đường lui: hoàn tác commit Pages nếu dropdown lỗi; phiếu mới có version riêng nên có thể đóng assignment trước khi học viên dùng, giữ nguyên bài đã nộp nếu đã phát sinh. API rollback phải giữ bốn biến cấu hình điểm danh và consumer `sync_portal_attendance`. Không xóa submission hoặc tự hoàn nguyên Portal.
