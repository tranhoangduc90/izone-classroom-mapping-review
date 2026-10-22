# Hướng dẫn bảo toàn Term Test/Mini Test K56–K67

Mục này áp dụng khi sửa/tạo Term/Mini hoặc phần dùng chung ảnh hưởng tới các test đó. Các sản phẩm khác giữ hướng dẫn và quyền hiện hành.

- Trước sửa, đọc [runbook nộp/phục hồi](backend/ops/releases/term-mini-submit-20261023/README.md), [hồ sơ thành quả và giới hạn](https://github.com/tranhoangduc90/izone-AI-team/blob/main/docs/TERM_MINI_THANH_QUA_VA_BAO_TOAN_2026-10-23.md), rồi đối chiếu đúng source/image/config live. K56 thật/demo có overlay lịch sử ngoài main; không rebuild toàn main để thay một module rồi làm mất overlay.
- Giữ bài, nháp, điểm, phiên bản chấm, token/generation, trạng thái thay thế, quyền lớp và đích Portal. Endpoint `submission-status` chỉ đọc SQL, không roster/start/chấm/ghi Portal; Reading không dùng guard chủ audio Listening K67. Không nới quyền để tránh lỗi fixture.
- Module canonical K67 và bản release phải khớp; giữ test parity và SQL/HTTP. Test mới cần đăng ký slug ở cả hai allowlist, kiểm đúng schema/profile, token/generation/snapshot, hai thứ tự và mode thực sự hỗ trợ. Không coi bản sao UI là đã có backend phục hồi.
- Giữ controller K56 v2/owner-hold K67, storage key, Writing revision/blank rule và chọn Writing độc lập phiếu L/R. Demo không ghi Portal; thi bù không mượn bài chính; không áp chính sách giờ của khóa hoặc sản phẩm khác.
- Kiểm phần sửa và consumer bị ảnh hưởng bằng dữ liệu giả riêng; không trỏ fixture vào DB production. Trước/sau phát hành so từng ID/hash dữ liệu cũ, phân loại ghi mới hợp lệ. Rollback runtime/asset tương thích phải giữ bài mới; không restore dump cũ, reset hoặc chấm lại để quay code.
- Tách Git đã nhập, runtime đã chuyển và kết quả người dùng đã quan sát. Giữ giới hạn chưa kiểm AI/Google/Portal/thiết bị thật; hướng dẫn này không cấp quyền production hoặc thêm cổng cơ học.
