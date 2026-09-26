# Phép thử API Term K56 đã dừng và rollback

Image `20260924.6-term-minimal-portal-rc` từng chạy ngắn trên production để thử GET Portal tối thiểu. Từ chính VPS1, GET Portal trả HTTP 403; route không chứng minh được đọc điểm dù API healthy và yêu cầu khóa đúng. Audit độc lập đã dừng trước PUT, không ghi điểm.

Kho K56 được kiểm độc lập là 0 attempt/run/job trước khi khôi phục đúng image cũ. Writer n8n-ai cũng trở về bản 13 node; K67 không đổi. Vì vậy đây chỉ là bằng chứng rollback khi kho trống, **không** chứng minh hạ image an toàn sau khi đã nhận bài K56.

`deploy_term_minimal_api.py` giờ chặn cả preflight và `--deploy` của ứng viên này trước khi đọc credential; `--rollback` chỉ còn là công cụ phục hồi có guard nếu đúng image thử vẫn đang chạy và kho K56 trống. `audit_term_minimal_live_route.py` giữ phép thử GET thực đã phát hiện 403 để không nhầm health/401 với kết quả nghiệp vụ. Không dùng image này làm cổng phát hành nếu chưa sửa lỗi và chạy lại từ VPS1.

Hướng đang xét là writer n8n 13 node giữ GET/PUT Portal OAuth hiện hành, chỉ đổi phần diễn giải Term 1/2 K56. Hướng này chưa được phát hành và phải qua readback Portal, hàng chờ, giao diện và K67 trên revision cuối.
