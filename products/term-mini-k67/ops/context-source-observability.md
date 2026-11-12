# Đọc độ trễ nguồn quyền lớp K67

`term-mini-k67-context-source` ghi một dòng JSON `k67_context_request` phiên bản 1 vào stdout cho mỗi yêu cầu đến `/v1/snapshot`, `/v1/homework/class-scope` hoặc `/v1/homework/erp-students`. Endpoint health tiếp tục kiểm tiến trình.

- `durationMs` tính bằng đồng hồ đơn điệu từ lúc vào handler tới khi Node hoàn tất gửi phản hồi hoặc kết nối đóng sớm. `stageMs` tách thời gian lấy kết nối, đọc từng view, mã hóa và gửi phản hồi của snapshot. Hai tuyến Homework đo `query` gồm cả thời gian lấy kết nối qua pool.
- `status` là mã HTTP khi gửi xong. Giá trị 499 cùng `CLIENT_DISCONNECTED` đánh dấu kết nối đóng trước khi hoàn tất gửi. `stage` cho biết bước còn chạy tại thời điểm ngắt.
- `errorCode` phân biệt từ chối khóa, chờ pool quá hạn, statement timeout, hủy truy vấn, lỗi kết nối và lỗi dựng phản hồi. Khi biết, `failureStage` và `sqlState` giúp thu hẹp nguyên nhân. Bản ghi chỉ chứa mã đã lọc, thời gian, route cố định, mã yêu cầu ngẫu nhiên và SHA của bản phát hành. `X-Request-Id` trả cùng mã trên phản hồi.
- Khi chạy bằng container, đặt `K67_CONTEXT_SOURCE_BUILD_SHA` bằng SHA nguồn và giới hạn dung lượng log Docker. Giữ các trường của bản ghi v1 khi thêm dữ liệu. Các lượt trước lúc triển khai chưa có phép đo này.

Đọc lỗi trong 20 phút gần nhất theo đúng container nguồn:

```sh
docker logs --since 20m term-mini-k67-context-source 2>/dev/null |
  jq -Rr 'fromjson? | select(.event == "k67_context_request" and .status >= 400) |
    [.at, .route, .status, .errorCode, .stage, .failureStage, .durationMs, .requestId] | @tsv'
```

Đối chiếu giờ UTC với lỗi từ caller. Một phản hồi nhanh sau khi client đã ngắt không chứng minh lần gọi trước đã thành công. Khi thiếu bản ghi ở nguồn, kiểm DNS, kết nối và mốc thời gian của caller. Khi quay lui mã nguồn, giữ kho dữ liệu hiện hành và đọc nhật ký của cả container mới lẫn container trước đó nếu sự cố nằm trong cửa sổ chuyển.
