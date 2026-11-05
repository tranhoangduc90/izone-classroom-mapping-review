# Progress Log theo mã buổi ERP cố định · 05/11/2026

Yêu cầu hiện hành: phiếu đã gắn một mã buổi ERP phải tiếp tục theo đúng mã đó khi trạng thái, ngày, giờ hoặc thứ tự lịch thay đổi. Quy tắc này thay việc buộc đối chiếu thủ công mọi thay đổi thời gian trong thiết kế 09/10; giữ guard cho đổi mã, mất/hủy buổi và nguồn mơ hồ.

- `learning-schedule-identity.js` chỉ cho làm mới fingerprint khi nguồn trước/sau cùng lớp, chứa đúng mã buổi đã giữ, không trùng/mơ hồ và buổi đích còn hoạt động. Không dùng số thứ tự mới để chuyển phiếu hoặc điểm danh.
- API mở bài và nhận bài giữ ID đã chốt. Journey, lịch cho bộ giao phiếu và kế hoạch giảng viên trả ngày/giờ hiện hành theo ID đó; bản kế hoạch cũ vẫn có giá trị lịch sử. Đọc lịch không sửa bài làm hoặc ghi Portal.
- Worker đọc lại fingerprint hiện hành trước khi dispatch, giữ nguyên binding revision/accepted_at và operation identity. Đã có write intent nhưng chưa rõ kết quả thì chỉ đối chiếu yêu cầu đó; không PUT lặp, không khóa cả phiếu.
- Thay đổi ngày/giờ không sửa mốc nộp thật, checkpoint, submission, quyết định điểm danh hoặc ngày lịch sử của operation. Cửa sổ thủ công chỉ dịch theo lưu kế hoạch khi phiếu chưa có lượt làm hoặc binding đã nhận; hạn tự khóa vẫn theo ngày học viên thứ ba nộp đủ.
- Cờ đối chiếu cũ không tự xóa hàng loạt. Phục hồi cần đối chiếu nguồn ERP và Portal, đúng assignment/target/revision, lưu trước/sau và kiểm dấu dữ liệu. Job review lịch sử không được replay chỉ vì binding đã được phục hồi.

Runtime có hai bản module: API dùng chung và native source của Portal Hub. Overlay cả hai trên đúng image live; giữ transport `deliveryHandler`, các tệp pin trong `native/source-sha256.json`, env/mount/network, quyền và writer ownership. Không rebuild toàn backend main để thay một phần rồi làm mất overlay sản phẩm khác.

Hồi quy: `learning-stable-schedule-postgres.test.js` tái hiện 0→1 và dời giờ cùng ID bằng role ứng dụng; giữ nháp/checkpoint/điểm danh. Bộ lịch, publications, database, attendance và isolation giữ chống đổi đích, lease, unknown và quyền. Kiểm 20 người đồng thời bằng PostgreSQL riêng; không dùng lớp thật làm fixture.

Đọc lại runtime và dữ liệu thật sau từng release. Health200 hoặc ca giả không chứng minh một lần ghi Portal mới. Bản sửa này không tạo bài nộp/điểm danh thử trên lớp thật.
