# Phục hồi Listening khi chuyển tab — 23/10/2026

Lỗi: nháp trên thiết bị đi trước mốc lưu quá 5 giây bị từ chối ở Pause, Resume, Reset và Submit. Các thao tác sau gửi lại cùng nháp nên không tự thoát lỗi.

Phục hồi hiện nhận phần active chưa ACK trong cửa sổ một heartbeat cộng một request đang chờ (5 + 5 giây), giới hạn bởi thời gian thực đã trôi và đối chiếu tiến độ audio. Không cộng thời gian rời tab. Khi qua cuối audio, giữ cả thời gian rà đã dùng.

Nếu tiến độ không thể xác minh, `recoverCheckpoint` giữ đáp án/ghi chú hợp lệ, giữ mốc nghe đã xác nhận và trả `progressRecovery`, trạng thái paused, không cấp lease mới hoặc tự nộp. Sai lease, nháp cũ và nháp sai cấu trúc vẫn bị từ chối. Reset do người dùng xác nhận có thể tạo lượt mới và giữ nháp/lịch sử lượt cũ. Frontend không tự phát lại Reset cũ khi bấm Tiếp tục; HTTP 4xx xác định được giải phóng khỏi hàng thao tác đang chờ, timeout chưa biết kết quả giữ mã chống gửi trùng.

Mã domain kế thừa `resultSummary`/trạng thái điểm Docs từ image production `score-docs-dd514e0b2b87`, phần chưa có trên base Git tại lúc bắt đầu. Không được làm mất overlay này khi rebuild. Đợt phát hành chỉ thay `domain.js` và `service.js` trên image live đã ghim; không migration hoặc sửa dữ liệu học viên.

Kiểm: `npm test`, gồm 10 ca hồi quy mới chạy cùng engine Buổi 8 và Buổi 10; bộ frontend Listening và mở bài; canary PostgreSQL riêng kiểm hai bài, nộp lặp, sai lease, bảo toàn lịch sử và trạng thái điểm Docs. Browser kiểm nháp cũ có pending Reset, tiếp tục cùng lượt, chuyển tab, tải lại và người giả tự nộp. Fixture không thay kiểm trên thiết bị học viên.

Phát hành: backup cấu hình/source/image/DB Listening; kế thừa đúng image live, chỉ chuyển container Listening sau canary. Giữ port host 18818, mount media, các container nguồn quyền/Reading/Term/Mapping. So work hiện tại trước/sau và đọc lại hash hai module. Không reset/nộp/chấm hộ hoặc restore database cũ. Khi hướng dẫn học viên, tải lại trang trong cùng trình duyệt rồi bấm Tiếp tục; giữ localStorage/sessionStorage, không xóa nháp.

Rollback riêng image/.env bằng backup tương ứng, giữ bài và schema hiện tại. Frontend tương thích backend cũ nhưng lỗi tiến độ cũ sẽ trở lại; không dùng rollback dữ liệu để quay code. Kho bằng chứng riêng ngày phát hành nằm ngoài Git, không nhập nháp, UUID, token hoặc nội dung đề vào repository.
