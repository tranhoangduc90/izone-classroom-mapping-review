# Xác minh dẫn chứng AI và đọc Share dự phòng — 02/11/2026

Sửa lỗi link bị dừng kiểm sau năm lần vì đọc dự phòng hoặc dẫn chứng AI không hợp lệ. Giữ policy `speaking-fairness-2026-10-18-v1`, recognizer v3, ngưỡng từng assignment, vai trò/thứ tự, chống trùng, snapshot và worker tiến độ Docs.

`speaking-ai-verification.js` cấp mã đoạn nguồn để AI chọn; máy chủ lấy nguyên văn và chạy lại các validator hiện hành. Phản hồi sai được yêu cầu sửa một lần, kèm lỗi và phản hồi cần sửa. Kết quả thiếu bài hợp lệ không bị yêu cầu sửa thành đạt. Không đổi provider hoặc mặc định confidence. Bài kể chuyện Lesson 10–12, bổ trợ và nhận diện lời hoàn tất dùng chung bộ này.

Reader giữ HTTPS/host/redirect, header 64 KiB, HTML 12 MiB và parser cũ. Đường dự phòng thử lại tối đa một lần với lỗi tạm thời, không thử lại 401/403; giữ provenance HTTP/gateway và operation ID. Ngân sách đọc 70 giây + kiểm chuẩn/sửa 80 giây + hoàn tất/sửa 40 giây nằm dưới lease bốn phút.

Chỉ triển khai bảy module thay đổi bằng overlay trên exact image Speaking riêng. `speaking-check-worker.js` canonical được đối chiếu lại với live để giữ đủ policy/snapshot đã chạy; file này không đổi so với live và không nằm trong overlay. Không rebuild toàn main hoặc đổi Mapping API, dữ liệu, broker, Pages hay credential.

Kiểm chứng gồm các regression RED trên base/GREEN trên bản sửa, toàn inventory Speaking, bản ghép exact-live và canary AI không ghi bài trên 13 link. Các lỗi nền ở bridge/how-to phải đối chiếu baseline, không coi là regression hoặc bỏ bằng cách sửa luật. Bằng chứng thật, kết quả test đủ điều kiện và trạng thái sau chuyển nằm trong kho riêng `E:/Codex-Data/speaking67-validation-audit-20261102/rootcause/release/`.

Khôi phục code bằng container/image trước chuyển đã giữ riêng cùng cấu hình; không restore database. Khi kiểm lại bài thật, dùng HTTP request check hiện hành, xác minh UUID/token/chủ bài và revision mới nhất trước ghi; không reset attempts hoặc ghi accepted bằng SQL. Luồng tự nộp/Docs tiếp tục theo engine hiện hành, không gọi finish thay học viên.
