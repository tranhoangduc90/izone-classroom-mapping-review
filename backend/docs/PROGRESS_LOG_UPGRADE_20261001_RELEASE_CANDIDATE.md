# Gói ứng viên nâng cấp Progress Log — IC2305

## Người dùng sẽ thấy

1. Học viên chọn tên trên phiếu đang dùng, bấm **Xem hành trình của em**: có dấu tải ngay, hết thời gian chờ được thử lại/quay lại phiếu và giữ nội dung đang viết.
2. Giảng viên mở **Hành trình lớp** trên dashboard: xem lịch toàn lớp, lọc tình trạng và mở bài của học viên. Buổi Test/không có phiếu không bị tính thành vắng. Reading/Listening hiện khi hoàn tất; Writing có trạng thái chờ rồi cập nhật muộn.
3. **Xác nhận ngày của từng buổi** tự đọc ERP; mỗi buổi có một ô chọn ngày/thứ/số buổi. Có **Đọc lại lịch học của lớp**; hệ thống đề xuất các buổi còn lại, giữ mốc đã gán và phần chỉnh; giảng viên xác nhận mới ghi.
4. Dashboard cho xem câu lớp sai nhiều, đáp án sai thường gặp và mở đúng bài. Mỗi học viên chỉ tính một bài hiện hành, không lấy lượt làm làm số người.
5. **Tạo phiếu** có soạn/copy/nhập/xem trước/lưu nháp/duyệt/phát phiếu. Chỉ tám nhóm đã kiểm kê; chưa thêm bài luyện vào Journey, dạng mới, AI chấm hay kết nối Đức Anh.

Lớp đầu tiên IC2305 là ERP **1294**, **31 buổi**. Việc người dùng từng mở IC2304 không đổi phạm vi yêu cầu.

## Bản đã kiểm

Mã nguồn ứng dụng, schema và tests: `source-sha256:f6d173b0f900d9f4a49014a49733ce2f0c5afd548a9c2ed695764035d2dacea0`.

| Kiểm tra | Kết quả |
|---|---|
| Full backend cuối | 303/303, không fail/skip |
| Toàn bộ nhóm Pages local | 38/38, không fail/skip |
| Callback học viên thực chạy Chrome | 2/2 |
| Chrome → API → DB | 1/1; tám dạng, sáu phiếu/57 câu/14 ô, drilldown đúng bài |
| Hai lỗi loading/date picker | Cùng test RED trên base, GREEN trên head |
| Review độc lập mã ứng dụng | Findings đã khép; không thay kiểm PostgreSQL/production |
| Checker chất lượng | Hợp lệ, `pending/not_ready` |

Script live smoke cần URL production và revision thực tế; chưa chạy cho ứng viên chưa phát hành. Các lượt test thất bại trước đó được giữ trong kho bằng chứng, không ghi lại thành PASS.

## Phần phát hành cần thực hiện

1. Chuẩn bị PostgreSQL/database riêng và image thử trên VPS trong đúng phạm vi task; chạy cổng nhiều connection đã chuẩn bị. Không dùng DB học viên làm fixture.
2. Backup database/config/image API và demo; kiểm backup và thử quay lại image cũ. Apply migration mới `202610010001_progress_log_form_drafts.sql`, đọc lại bảng, quyền và triggers. Không sửa migration đã phát hành.
3. Đóng overlay trên API live `izone-speaking-course67:20260930-v2`; 14 source API cần thay/thêm đã đối chiếu base. Giữ module nền, phiên giảng viên 90 ngày và cấu hình/consumer điểm danh. Demo riêng live `izone-progress-log-demo:20260929.1` cần module Learning mới và initializer Journey; không dùng bản source API để dựng lại toàn bộ các dịch vụ khác.
4. Khi image thử/migration/rollback đạt, chuyển API và demo, kiểm luồng nhìn thấy thực tế; sau đó mới phát hành Pages.
5. Readback IC2305: lịch31buổi, proposal/chốt revision, Overview/detail, form draft/demo/publish đúng version/hash/roster. Kiểm bài nộp hợp lệ tới kết quả điểm danh đọc lại từ Portal. Chưa có ca mới thì giữ `deployed_awaiting_validation`.

## Quay lui

Chuyển API/demo/Pages về revision/image đã giữ trước phát hành; tắt soạn/publish mới khi cần. Giữ bảng, nháp, version, assignment, bài và điểm đã nhận. Không DROP dữ liệu, không tự sửa/hoàn nguyên Portal. Nếu guard có lỗi, dùng migration mới được review, backup và đọc lại, không gỡ guard tùy tiện.

## Trạng thái quyền và bước tiếp theo

Đây là gói source local, chưa apply migration/chuyển dịch vụ/merge/push gói backend mới. AGENTS của workspace quy định ghi VPS, chạy migration, dựng/chuyển dịch vụ cần quyền rõ; quyền phát hành Journey trước đây không tự mở gói schema/API mới. Khi được duyệt gói này, đi lần lượt các cổng trên; chỉ phát hành nếu các kiểm tra bắt buộc đạt.

Chi tiết registry/API: [runbook](PROGRESS_LOG_UPGRADE_20261001_RUNBOOK.md). Trạng thái từng mã nghiệm thu và bằng chứng: [manifest](PROGRESS_LOG_UPGRADE_20261001_QUALITY_GATE.json). Tool cập nhật graph được AGENTS Pages yêu cầu chưa có trong inventory; hợp đồng module/interface đã ghi trong manifest, chưa tuyên bố đã chạy tool đó.
