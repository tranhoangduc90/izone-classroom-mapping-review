# Phát hành Progress Log IC2305 buổi 3 — 21/09/2026

## Phạm vi

- Image nền là bản production hiện hành `1.10.0-dashboard-access`.
- Bổ sung contract dạng chuỗi lập luận, trường “Khác” có điều kiện và template buổi 3.
- Không thay schema, secret, network, Portal, Term Test hoặc dữ liệu buổi cũ.
- Assignment chỉ được tạo sau backup PostgreSQL đã kiểm và đọc lại quyền/roster.

## Cổng phát hành

1. Backend full suite, checker và test frontend Progress Log đạt trên đúng commit nguồn.
2. Dockerfile kiểm hash image nền và source mới trước khi ghi file.
3. `deploy.sh --deploy` chạy lại checker quyền và canary dashboard; lỗi sẽ tự quay lại image nền.
4. Script phát hành assignment chạy trong container dùng pool một kết nối, transaction và advisory lock.
5. Readback phải xác nhận đúng IC2305, buổi 3, hash definition, roster không rỗng, ba phần mở.
6. Pages thật phải tải đúng asset revision, không lỗi console/network và không chứa đáp án.

## Quay lại

Chạy `deploy.sh --rollback` để dựng lại API bằng image `1.10.0-dashboard-access`. Không xóa
assignment hoặc bài làm. Nếu assignment vừa tạo cần ngừng dùng, đóng assignment bằng một thay
đổi nghiệp vụ có audit riêng; không xóa trực tiếp khỏi database production.
