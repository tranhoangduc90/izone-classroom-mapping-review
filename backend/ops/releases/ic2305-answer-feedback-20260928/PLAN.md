# IC2305 khóa 56: hiện kết quả chấm tự động

## Phạm vi nghiệm thu

- `small_complete`: bốn phiếu đang phát hành của buổi 2–5; học viên thấy số câu đúng, đúng/sai từng câu có chấm và đáp án đúng sau khi nộp phần; sau nộp phiếu cuối vẫn xem được kết quả.
- Câu tự luận, Hedging và tự đánh giá Speaking vẫn không có đáp án hay nhận xét chấm tự động.
- Giữ nguyên form version, definition hash, link, lượt đang làm, bài đã nộp, điểm danh và dashboard giảng viên. Không bật chính sách này cho lớp khác.
- Một phiếu demo riêng của buổi 5 dùng đúng form version và lớp demo đã có. Một hồ sơ học viên giả có thể làm lại nhiều lượt; không xuất hiện trong roster IC2305 thật và không gửi điểm danh tới Portal.

## Thiết kế vận hành

- API đọc chính sách hiện đáp án ở cấp assignment; giá trị mặc định kế thừa form version. Chỉ bốn assignment IC2305 được bật bằng script có guard. Khóa đáp án nằm ở database và chỉ được đưa vào response sau checkpoint/final submit, không nằm trong API mở phiếu hoặc trang tĩnh.
- Tải dự kiến: dưới 20 học viên mỗi phiếu theo số lượt production hiện có; thêm một trường trong truy vấn hiện hữu, không thêm round trip. Mục tiêu giữ thời gian trả checkpoint hiện tại. Không gọi dịch vụ ngoài mới, không tăng quota.
- Nếu migration/script lỗi, transaction rollback. Nếu API lỗi trước khi bật chính sách, quay về image API cũ. Nếu lỗi sau khi bật, giữ dữ liệu và sửa tiến tới; có thể đổi bốn chính sách về kế thừa trong giao dịch guarded để ngừng hiện đáp án. Không sửa/xóa submission hay attempt.
- Chỉ bỏ tác vụ Portal khi đồng thời có mã khóa `DEMO-56` và ID lớp demo `990000567`; mọi phiếu lớp thật tiếp tục tạo tác vụ điểm danh như cũ.
- Theo dõi: health API, kết quả submit/replay, số lượt/bài trước–sau, hàng chờ và outcome `sync_portal_attendance`, và màn hình học viên ở máy tính/điện thoại. Trước và sau deploy đối chiếu cấu hình điểm danh, worker và đích Portal.

## Lát triển khai

1. Migration + API đọc chính sách assignment và trả kết quả sau nộp; test riêng quyền xem đáp án, replay và bài tự luận.
2. Giao diện giữ học viên ở phần vừa nộp để xem đúng/sai; màn hình hoàn tất hiện kết quả tất cả câu có chấm; test UI.
3. Full suite, checker cổng chất lượng, backup/readback production, merge/push main theo quyền Đức đã cấp.

Điểm dừng: bất kỳ test P0/P1 hỏng, thay đổi hash/version hoặc số bài/lượt, thiếu cấu hình điểm danh, hoặc API/UI không hiện kết quả thực tế thì không gọi là hoàn tất.
