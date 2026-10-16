# K67: quyền phát audio duy nhất

Ngày 15/10/2026. Chưa phát hành production.

`K67_AUDIO_OWNER_ENABLED` mặc định false. Migration `012-audio-owner.sql` thêm chủ phát, hash bằng chứng chủ, trang chủ và epoch vào session. Endpoint `session/audio-owner` kiểm quyền phiên/thế hệ, khóa session rồi status/claim/release. Không tự hết quyền, không lấy heartbeat làm bằng chứng thiết bị cũ đã dừng. Phiên đã bắt đầu trước khi bật cờ không bị nâng protocol giữa chừng.

Claim đầu lưu hash bằng chứng ngẫu nhiên; retry cùng trang là idempotent. Reload cùng bằng chứng và đã lấy Web Lock phía client có thể reclaim, tăng epoch để chặn trang cũ. Máy chủ không xác minh được Web Lock và không coi đây là bảo vệ chống client cố ý giả mạo. Release sau khi bắt đầu chỉ được nhận khi đã mở sự cố giữ bài.

Mọi đường start, access, incident, recovery kiểm chủ hiện tại. Pool đặt ID/proof/epoch/generation bằng `SET LOCAL` trên đúng connection/giao dịch. Trigger kiểm lại các thay đổi Listening của session và attempt dưới khóa hàng; đường draft/submit cũ hoặc tokenless không vượt guard. Reading/Writing không bị khóa theo chủ phát audio. Đổi generation/supersede xóa chủ và tăng epoch. Không gửi raw proof qua log hoặc response.

Triển khai tương lai phải đưa migration/backend tương thích lên trước frontend rồi bật trên phiên mới có kiểm soát. Khi quay lui, tắt nhận phiên mới và giữ backend hiểu protocol cho đến khi xử lý xong phiên đang hoạt động. Không xóa cột/trigger để vượt lỗi khi học viên đang thi.

Kiểm local gồm ba slug, hai thứ tự thi, claim cạnh tranh, stale epoch, proof/generation sai, start bỏ protocol, draft/submit legacy, chuyển giữ nguyên incident và không bù/nộp từ chủ cũ. Bộ native PostgreSQL kiểm guard thật, ngoài fixture nhúng. Kết quả cuối và giới hạn thiết bị thật được ghi trong báo cáo riêng lát 3.
