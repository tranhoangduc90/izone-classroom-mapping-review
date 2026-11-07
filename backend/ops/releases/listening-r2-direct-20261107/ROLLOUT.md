# Biên nhận phát hành · Listening R2 direct

Ngày 07/11/2026. Production bật 5 bài Homework và lượt mới Buổi 8, Buổi 10, C21 full (Buổi 15) của Listening thực chiến. Native API vẫn kiểm người/lớp/Docs/lượt trước khi ký GET 10 phút. Trang mới dùng một GET R2, kiểm hash và có Pages dự phòng. Lượt thực chiến đã tồn tại giữ policy cũ.

| Bước | Mốc UTC | Readback |
|---|---|---|
| Backend tương thích, direct tắt | 03:15–03:17 | Hai health 200; quyền thiếu 401; config node đọc được; startup giữ journal |
| Pages | Sau merge 03:19:28 | [Build thành công](https://github.com/tranhoangduc90/izone-ai-team-pages/actions/runs/42333496462), 15 HTML/module live khớp; API preflight 204 cho header mới |
| Homework Scandinavian | 03:25:01 | Một asset đúng manifest, GET 200, hash/byte đúng; thiếu quyền 401 |
| Homework rollback drill và mở rộng | 03:25:54–03:26:03 | Tắt → descriptor vắng, bật lại → đúng cùng hash, sau đó 5/5 đúng |
| Thực chiến | 03:28:30–03:28:47 | Buổi 8 → tắt → Buổi 8 → Buổi 10 → C21 full; 3/3 đúng hash/byte, thiếu quyền 401 |

Backend giữ image gốc, port/mạng/giới hạn/tùy chọn bảo mật và các mount ngoài phần sửa. Source overlay live khớp 3 file Homework và 5 file thực chiến; cả hai container backup thoát graceful (exit 0). Backup dump và cấu hình Docker nằm trong thư mục private ghi ở runbook. Quay lui bằng cờ từng sản phẩm, không phục hồi database.

Đối chiếu database: 15 nháp cũ, 17 lượt, 17 kết quả Homework giữ nguyên từng hash; có 1 nháp mới và một cập nhật trạng thái Docs đúng chủ/phiên của nháp mới (sequence 0 → 1), không mất dòng. Bốn bảng content/assignment/binding/work thực chiến khớp hash trước–sau. Không dùng học viên thật để tạo lượt, nộp/chấm bài hoặc gọi AI trong nghiệm thu.

Kiểm hồi phục: hai native app và trình duyệt chạy với dữ liệu giả; thực chiến Bắt đầu/Tạm dừng/Tiếp tục/reload giữ cùng lượt, một GET audio và cache bền; bài full có ca native giữ thời gian rà và nộp một lần. Chrome resume prefix tại byte 1.572.864, link thật hết hạn được renew một lần, native từ chối thì dừng; lỗi IDB dùng RAM; deadline 120 giây dừng an toàn. Review có 11 ca direct và 11 ca legacy, không tính ca hidden trong các số này.

Giới hạn: ca visibility được mô phỏng trên Chrome chạy native API và R2, về lại tab không tự phát và tiếp tục đúng vị trí. Cơ chế duyệt tự động chặn mở phiên Chrome mới (`blocked by policy`); phiên Chrome dự phòng không phát sự kiện hidden thật khi đổi tab, nên chưa xác nhận ca đó bằng tab vật lý. Chưa kiểm iPhone/Safari vật lý. Hậu kiểm tức thời chưa thấy lượt thực chiến mới mang policy R2; nháp Homework mới không chứng minh đường audio thực tế. Một tín hiệu `LEARNING_JOURNAL_SOURCE_FAILED` đã xuất hiện ở Homework, chưa xác định nguồn; health, quyền, hash audio và dữ liệu nghiệp vụ vẫn qua readback. Không suy từ đây rằng toàn bộ nhật ký đã được quan sát đủ.

Nguồn Git đã vào main: [Homework #96](https://github.com/tranhoangduc90/izone-writing-task1-practice/pull/96), [thực chiến #163](https://github.com/tranhoangduc90/izone-classroom-mapping-review/pull/163), [Pages #463](https://github.com/tranhoangduc90/izone-ai-team-pages/pull/463). Ba checkout main local có thay đổi riêng nên giữ nguyên; worktree tác vụ và remote main chứa commit phát hành.

Bằng chứng riêng trên máy: `E:/Codex-Data/listening-r2-direct-20261107/`, gồm `media-browser-results.json`, `native-browser-results.json`, `practice-browser-results.json`, `fault-browser-results.json`, `rollout-receipts.jsonl`, `final-readback.json`, `homework-db-diff.json`. Link ChatGPT Share chỉ trả tiêu đề/không trả hội thoại qua helper và trình duyệt; quyết định triển khai dựa trên kết quả đo trực tiếp và kiểm native.
