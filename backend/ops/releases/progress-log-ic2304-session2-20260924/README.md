# Phát hành IC2304 Buổi 2 · Listening, Writing, Speaking

## Kết quả

- Giữ link và danh sách lớp hiện có.
- Chấm năm câu Listening ngay sau khi nộp phần; dashboard giảng viên hiện số đúng.
- Thêm phần Speaking tám mục, tối đa hai mục, ba ô nhập tự chọn; Speaking khóa mặc định để giảng viên mở.

## Trình tự và cổng dừng

1. Đối chiếu image đang chạy với bốn hash trong Dockerfile; build image kế thừa image live, không thay cả ứng dụng bằng source Git cũ.
2. Đưa frontend Pages mới lên trước; bản này vẫn đọc được form v1 đang chạy.
3. Kiểm image mới bằng `deploy-api.sh --check`, chuyển API bằng `--deploy`, đọc health và canary IC2304 (phiếu, roster, quyền lớp và trạng thái từng phần).
4. Sao lưu đúng một lượt thử chưa nộp cuối vào vùng riêng trên ổ E. Không đưa snapshot, token hoặc bài làm vào Git/log.
5. Chạy `upgrade-ic2304-session2-speaking.mjs --apply --remove-single-test-attempt --backup-hash=... --approver=...`. Người duyệt khác người tạo phải có quyền lớp; nếu trùng người tạo, phải có thêm quyền lead khóa được tự duyệt form có điểm. Script khóa assignment, đối chiếu hash backup, chỉ xóa đúng một lượt thử active cùng checkpoint của nó, rồi chuyển form v1/v2 sang v3 trong **cùng giao dịch**. Nếu có dữ liệu mới hoặc sai quyền, toàn bộ rollback.
6. Đọc lại form version, ba block, roster, số lượt làm và API công khai; kiểm trang học viên/giảng viên và console/network.

## Hoàn tác

- Nếu API lỗi **trước** bước 5, khởi động lại container backup `mapping-review-api-before-ic2304-v3-20260924`; không sửa database.
- Sau bước 5, image cũ không hiểu form v3. Nếu chưa có lượt làm mới, chỉ chuyển assignment về v1 trong giao dịch đã duyệt rồi mới đổi image. Nếu đã có lượt làm mới, giữ image mới và sửa tiến tới; không đổi version bên dưới bài học viên.
- Bản sao lưu lượt thử chỉ dùng khi bước chuyển lỗi hoặc cần phục hồi có mục tiêu. Khi production đã đọc lại đạt, xóa bản sao riêng tư vì Đức yêu cầu xóa dữ liệu thử.
