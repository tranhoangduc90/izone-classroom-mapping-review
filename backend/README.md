# API duyệt mapping độc lập

API này phục vụ web duyệt mapping mà không dùng execution của n8n. n8n chỉ còn nhiệm vụ quét ERP, Classroom và Lark theo lịch rồi ghi dữ liệu vào PostgreSQL.

## Đăng nhập và phân quyền

- Giảng viên đăng nhập bằng tài khoản Google bất kỳ; không cần cùng tên miền.
- Email phải có trong `mapping.reviewer_account` và đang ở trạng thái `active`.
- Quyền theo lớp nằm trong `mapping.reviewer_class_access`.
- Tài khoản có `can_access_all_classes = true` được xem mọi lớp.
- Lần đăng nhập đầu gắn email được cấp quyền với mã tài khoản Google ổn định (`sub`). Các lần sau phải đúng cùng tài khoản đó.
- Chế độ mã dùng chung `legacy` chỉ dùng ngắn hạn khi chuyển hệ thống, không phải thiết kế vận hành lâu dài.

Google ID token chỉ được giữ trong bộ nhớ tab trình duyệt và gửi trong header `Authorization`. API không dùng cookie, không lưu token và không ghi dữ liệu học viên vào log.

## Chạy local

1. Sao chép `.env.example` thành `.env` rồi điền cấu hình thật ở máy chạy; không commit file này.
2. Chạy `npm install`.
3. Chạy `npm test` và `npm run check`.
4. Chạy `npm start`.

Endpoint kiểm tra: `GET /health` và `GET /ready`.

## Triển khai production

- Container `mapping-review-api` và PostgreSQL mapping cùng nối vào network riêng `mapping-api-net`. API không cần tham gia network của n8n.
- Cổng 8788 chỉ bind vào `127.0.0.1`; Nginx công khai đường dẫn `/mapping-api/` qua HTTPS.
- Container bị giới hạn 0,5 CPU, 256 MB RAM và 100 process để không chiếm hết tài nguyên của n8n.
- Log container tự xoay vòng, tối đa khoảng 30 MB, để không làm đầy ổ đĩa VPS.
- Cần áp dụng migration `docs/migrations/2026-08-06-independent-api-auth.sql`, tạo DB user chỉ có quyền cần thiết, rồi mới bật API.

Nếu API lỗi, giảng viên thấy thông báo hệ thống tạm thời không phản hồi; workflow quét dữ liệu nền của n8n vẫn tiếp tục độc lập.
