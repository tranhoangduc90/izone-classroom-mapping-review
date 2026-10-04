# Kiểm giao diện lưu bài Writing bằng bài giả

Công cụ nhận danh sách bảy bài giả, phiên bản API/frontend và gói phát hành đã cố định. Nó mở hai cửa sổ Writing, cho một bản lưu đến trước và một bản đến trễ, rồi đối chiếu nội dung nhìn thấy với nội dung trong database. Ca chỉ đạt khi cả hai Task, lựa chọn xử lý xung đột và bản khôi phục đều đúng, và dữ liệu thử đã được dọn sạch.

## Trình tự

1. `ui_producer.prepare` chỉ ghi kho riêng trên C. Mỗi tổ hợp giao diện/API có UUID, mã đánh dấu và hai mã ERP âm riêng. Không tạo bài trên production ở bước này.
2. `ui_producer.run` kiểm đủ bảy ca và mọi danh tính, đích, gói, file giao diện, cấu hình RPC; kiểm asset công khai và ba API đúng phiên bản trước bài giả đầu tiên. Kế hoạch rỗng, thiếu ca hoặc bị thay phải dừng trước seed.
3. `ui_rpc.call` lưu request và packet trước SSH. Sổ được giữ nguyên bytes, gồm CRLF/LF của Windows; hash nội dung và hash file là hai trường riêng.
4. `ui_rpc_remote.perform` đối chiếu bytes và nội dung sổ. Journal ở cả C và VPS giữ cố định ca/gói/sổ qua từng sequence, có khóa độc quyền và không tự hết hạn. Mỗi operation kiểm ownership/image/đích trước và sau.
5. `ui-canary.cjs` thao tác textarea/nút trên Chrome thật. Chỉ start/draft được gửi qua cầu nối; roster/result/auth của vỏ kiểm là dữ liệu giả. Không suy từ ca này rằng đăng nhập hoặc toàn hành trình học viên đã được nghiệm thu.
6. HTTP không theo redirect. Cleanup chỉ được phép khi Chrome đã đóng, không có HTTP pending, sender không unknown, đúng UUID/mã đánh dấu/ERP âm, chưa submit, không có exam session và năm bảng con đều rỗng. Sau xóa phải đọc lại đủ ba nhóm số còn lại bằng 0.
7. `browser_receipt.py` đối chiếu bảy receipt, trace request/ACK, SQL, asset và cleanup với sổ/gói. Các lớp Docs, điểm danh và quan sát production phải có bằng chứng riêng; cờ `passed` đơn lẻ không đủ.

## Khi gián đoạn

Giữ `executor.lock`, request/packet và trạng thái `unknown`; không tự gửi lại hoặc cleanup. Đối soát PID trong khóa C/VPS, PID producer và trạng thái command/SSH trước khi recovery. Timeout, đóng SSH và HTTP abort không chứng minh SQL hay tiến trình con đã dừng. Không mở khóa theo tuổi lượt. Hiện chưa có recovery tự động bằng CAS cho sender UI, nên ca gián đoạn cần đối soát riêng trước tiếp tục.

Journal dùng exclusive create, flush/fsync file và fsync thư mục lá trên POSIX. Chưa có bằng chứng phục hồi qua mất điện trên Windows hoặc các thư mục cha mới tạo; không chứng nhận độ bền qua mất điện và không dùng hạn chế này để cho phép replay.

## Bằng chứng fixture

`exercise_ui_rpc_docker.py` dùng ba image và PostgreSQL thật trong mạng Internal, chỉ vận hành container có label/ID của lượt thử. Lịch sử request được sao chép ngay lúc gửi để thao tác đổi baseRevision sau đó không sửa bằng chứng cũ. Fixture API/SQL này không thay Chrome/public asset, cấu hình production hoặc kết quả người dùng sau phát hành.

Runner unit chuẩn là Python unittest discovery cho `test_*.py`; Node test runner gọi `test_ui_payload.cjs`, `test_ui_finalization.cjs`, `test_ui_close.cjs`. Các test bảo vệ đủ ca, pin danh tính/gói/sổ, không gửi tới đích phụ, giữ unknown khi mất phản hồi và ngăn cleanup chưa an toàn. Không đưa request, token, credential hoặc dữ liệu học viên vào Git.
