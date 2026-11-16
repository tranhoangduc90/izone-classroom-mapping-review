# Ứng viên chuyển nhật ký Speaking Homework độc lập

Bản API cho gói runtime Speaking đang phục vụ, vốn ghép thêm overlay so với `backend/src` trên main. `stage-api.mjs` chỉ áp trên bản sao của đúng hai tệp nguồn có SHA-256 đã ghi trong script. Giữ nguyên grant native, giao diện, lưu bài, nộp và chấm. `stage-collector.mjs` dựa vào SHA-256 đọc từ image Collector dự kiến sử dụng, cùng các điểm gắn đã kiểm trên fixture.

## Hai công tắc

| Nhánh | Cấu hình | Hoạt động |
|---|---|---|
| Browser | `SPEAKING_JOURNAL_CLOUD_BROWSER_MODE_FILE`, `SPEAKING_JOURNAL_CLOUD_APPEND_KEY_FILE` | Thiếu cấu hình dùng grant và Collector cũ. Khi khai báo, file mode nhận `collector` hoặc `cloud`. API chỉ cấp thêm vé cloud append sau grant native, cùng scope và khóa riêng. Pages có địa chỉ Worker cố định. Lô đã cố định ở mỗi tuyến vẫn có danh sách ID riêng trong IndexedDB. |
| Agent | `SPEAKING_JOURNAL_CLOUD_SERVER_MODE_FILE` | Thiếu cấu hình dùng handler Collector cũ. File mode nhận `collector`, `cloud` hoặc `hold`. Cờ cloud chỉ định tuyến `POST /producer/speaking-homework` từ loopback, với tối đa hai lượt chuyển tiếp cùng lúc. Worker nhận nguyên frame đã mã hóa. Các đường khác giữ logic cũ. File đã cấu hình mà lỗi thì `hold` để Agent tiếp tục giữ lô. |

Cấu hình thử riêng hai nhánh và bật browser trước. Nếu quay lui browser, lô mới về Collector sau lần làm mới chính sách. Lô cloud đang chờ được giữ theo ID đến khi đối chiếu. Nếu quay lui server khi còn kết quả chưa rõ, dùng `hold`, đối chiếu frame và log cloud rồi mới mở lại đích phù hợp. Hai kho cloud vẫn được tra và xả sau khi tắt nhánh mới.

Ứng viên browser chỉ làm mới chính sách khi grant đã bật quản lý tuyến và tab có phát sinh log. Trần theo thiết kế là khoảng 60 lần/giờ cho mỗi tab có log liên tục, ngoài lần cấp vé khi mở hoặc đổi phạm vi. Phiên bản đã thử ở sandbox rút ngắn thời gian để kiểm chuyển tuyến, cần đo lại nhịp ở cấu hình phát. Cờ server đọc theo request vào và cache 5 giây. Health trả số lượt chuyển tiếp, byte request/response và số lỗi upstream riêng.

Các lần phát cần gắn collector SHA, image API, revision Pages, CSP, tài nguyên cloud đã đối chiếu, phạm vi, dự toán và số đo trước/sau vào hồ sơ triển khai.
