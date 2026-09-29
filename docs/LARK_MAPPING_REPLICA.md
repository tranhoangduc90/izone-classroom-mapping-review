# Bản sao mapping sang Lark — đã ngừng

Từ ngày 30/09/2026, Đức đã chọn dùng các bản sao PostgreSQL trên VPS2 và VPS3 để phục hồi `mapping_db`, đồng thời ngừng luồng phản chiếu mapping sang Lark. PostgreSQL vẫn là nguồn chuẩn. Các bảng Lark cũ được giữ nguyên như dữ liệu lịch sử; không dùng chúng để đánh giá độ mới của database.

## Trạng thái triển khai

- Container `mapping-lark-sync` trên VPS1 đã dừng và có chính sách khởi động lại `no`.
- File `backend/compose.lark-sync.production.yml` đặt service trong profile `retired`; lệnh Compose thông thường không chọn service này. SHA-256 của file nguồn khớp đúng file đang dùng trên VPS1 tại lần readback ngày 30/09/2026.
- Lịch Codex `Theo dõi bản sao mapping sang Lark` đã bị xóa. Không diễn giải việc thiếu cảnh báo từ lịch này là bằng chứng Lark còn đồng bộ.
- API mapping và PostgreSQL là container riêng; chúng vẫn chạy ở lần đọc lại sau khi dừng worker.

## Kiểm phục hồi đã làm

Archive `20260928T192025Z` trên **từng VPS2 và VPS3** vượt kiểm SHA-256, rồi phục hồi thành công bằng `pg_restore --exit-on-error` vào PostgreSQL 16.15 tạm, mạng tắt (`--network none`). Mỗi bản có 163 bảng, 13 view và 52 routine. Container và volume tạm đã dọn. Không kết nối hoặc chạy SQL trên `mapping_db` thật. Bằng chứng này chỉ xác nhận đúng mốc 28/09/2026; cần kiểm các archive về sau riêng trên từng VPS.

## Trước lần triển khai backend tiếp theo

1. Dùng file Compose **được Git theo dõi** ở đường dẫn trên. File cục bộ cũ chưa được Git theo dõi, có `restart: unless-stopped`, từng khớp bản production trước khi ngừng; không dùng nó để triển khai.
2. Kiểm lệnh Compose mặc định trả **0 service** và không bật profile `retired`. Việc bật worker trở lại là thay đổi nghiệp vụ mới, cần quyết định và kiểm riêng.
3. Sau triển khai, đọc lại `mapping-lark-sync`: trạng thái phải là `exited` và restart policy phải là `no`; xác nhận API và PostgreSQL vẫn chạy. Chỉ đọc trạng thái container, không thử đồng bộ hoặc truy vấn database thật để kiểm việc nghỉ.

Bản Compose production trước khi ngừng được lưu trên VPS1 tại `/opt/mapping-lark-sync/app/compose.lark-sync.production.yml.before-retire-20260929` để phục vụ hoàn tác có chủ ý. Không tự phục hồi bản đó trong một lần triển khai backend thông thường.
