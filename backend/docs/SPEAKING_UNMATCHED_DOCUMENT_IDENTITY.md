# Chọn tên khi Docs Speaking chưa xác định được chủ bài

- Docs đã đối soát với Classroom giữ màn hình một học viên. Không dùng tên Google làm tên hiển thị.
- Docs chưa đối soát nhưng link có lớp hợp lệ trả `intakeMode: unmatched`, danh sách tên ERP đang học và lựa chọn đã lưu cho bản Docs.
- Danh sách tự chọn dùng `selectionStudents`; danh sách `students` và `member` cho xác nhận nguồn vẫn yêu cầu mapping `approved`.
- Giữ nguyên giao diện, mã bài, Doc ID và vùng ghi biên nhận. Link Docs không có lớp tiếp tục hành trình bài riêng.
- Khi bấm Mở bài, tên tự chọn được lưu vào hồ sơ loại `document`, cùng sự kiện `identity_selected`. `course_id` và `linked_profile_id` vẫn trống: thao tác này không duyệt mapping, không nhập lịch sử Doctor của một hồ sơ khác.
- Có thể chọn lại trước khi lưu link đầu tiên. Khi đã có link hoặc biên nhận, đổi người bị chặn để giữ tiến độ của đúng người; giảng viên cần kiểm trường hợp chọn nhầm.
- Mỗi lượt đọc/lưu kiểm lại học viên còn trong danh sách đang học của lớp. Mã hồ sơ ngoài lớp, nghỉ học hoặc lớp không hợp lệ bị từ chối.
- Nguồn Classroom đến sau và khớp cùng người mới nối hồ sơ cá nhân theo hành trình cũ. Nguồn khác người/lớp chuyển sang `review`, giữ nguyên bài và danh tính tự chọn.
- Không đổi bảng mapping, schema, workflow Classroom, bộ kiểm hội thoại hay cấu hình điểm danh.

## Kiểm thay đổi

Các ca trong `backend/test/speaking-independent.test.js` kiểm chọn tên chưa duyệt, phiên ổn định, khóa đổi người, nộp đủ năm link, đúng đích ghi biên nhận và nguồn Classroom đến sau. Chạy bằng PostgreSQL fixture riêng để kiểm khóa giao dịch thật.

Ca trong `backend/test/speaking-catalog.test.js` dùng SQL thật để kiểm tên ERP/đăng ký hiện hành và giữ riêng danh sách approved. Frontend `tests/speaking-homework-identity.mjs` kiểm cả màn hình điện thoại và desktop, chọn tên, giữ Docs và khôi phục lựa chọn.

Khi phát hành API dùng chung, giữ cấu hình của container live; kiểm source còn nguyên ngoài ba module Speaking được sửa, cookie giảng viên 90 ngày và worker/hàng điểm danh. Quay lui code không được quay lui dữ liệu bài học viên.
