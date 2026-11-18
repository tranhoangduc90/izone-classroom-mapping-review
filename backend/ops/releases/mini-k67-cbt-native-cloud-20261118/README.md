# Nhật ký biên nhận API Mini K67 CBT

Gói này đọc lại lần nộp Listening hoặc Reading đã được ghi vào bảng CBT và chuyển metadata kỹ thuật theo phạm vi đúng lượt. Dùng `operationId` từ biên nhận đã lưu và thời điểm nộp từ bản ghi native. Định danh sự kiện giữ ổn định khi gửi lại. Các phiên Nghe trước có thể dùng kiểu `legacy`, nên điều kiện SQL vẫn buộc có CBT journey ở đúng thế hệ và lượt thi. Luồng phiếu có binding riêng.

`stage.py RUNTIME OUTPUT` ghim adapter của API `9243bccd` theo SHA-256 và tạo bản runtime thử ở thư mục mới. Bản runtime nhận `K67_MINI_CBT_NATIVE_ROUTE_FILE`, `K67_MINI_CBT_NATIVE_SPOOL_ENDPOINT` và `K67_MINI_CBT_NATIVE_SPOOL_KEY_FILE` từ cấu hình triển khai. Route mặc định theo Collector. Agent, Worker, khóa riêng và kho xuất là phần triển khai tách riêng.

Đưa route về Collector cho quyết định gửi mới và giữ đường xả frame cũ khi quay lui. Hàng đợi phía API từ chối trước khi gửi cũng về Collector. Khi không rõ kết quả gửi, đếm lỗi ở adapter và giữ đúng đường xả nhằm tránh chuyển cùng sự kiện sang nguồn thứ hai. Nghiệp vụ lưu bài và biên nhận không chờ nhật ký.

Đã kiểm trên PostgreSQL cách ly cho hai thứ tự, bật và tắt giữ đối soát. Đã diễn tập ca đóng tuyến, nhận lô, mất phản hồi và hết sức chứa từ broker. Một ca riêng dùng sự kiện từ SQL qua SQLite bền, Worker Miniflare và kho xuất mô phỏng. Cần kiểm Agent và hai kho thật trước khi bật route.
