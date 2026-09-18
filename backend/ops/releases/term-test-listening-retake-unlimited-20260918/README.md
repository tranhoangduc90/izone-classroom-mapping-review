# Mở lại lượt thi bù Listening chưa bắt đầu — 18/09/2026

Bản phát hành này chỉ sửa backend của Term Test 1. Vé thi bù v2 có chữ ký, giới hạn đúng bài/lớp/học viên và không có ngày hết hạn. Vé v1 cũ vẫn được nhận cho đến ngày hết hạn của chính vé đó.

Phiên đã chuẩn bị quá 8 giờ chỉ được mở lại nếu chưa bấm bắt đầu, chưa nộp và chưa tạo attempt. Câu SQL đối chiếu đồng thời UUID phiên, bài thi, phiên bản đề, lớp và học viên; không gia hạn đồng hồ của phiên đang làm. Việc chấm Listening và ghi Portal vẫn dùng luồng hiện có. Không thay đổi Reading/Writing, không migration và không ghi thông tin học viên hoặc vé thật vào Git.

Image mới là lớp phủ trên `izone-term-test-backend:20260916.4-progress-log-checkpoint-retry`. Khi build, script so SHA-256 của hai file nguồn trước và sau vá; sai phiên bản thì build dừng. Kiểm thử route và SQL nằm trong `test/listening-retake-unlimited.test.js`.

Kiểm thử đã chạy trên bản source lấy từ image production: 5/5 ca đạt. Trước phát hành cần backup cấu hình/image hiện hành, kiểm Compose, build thử và giữ image cũ để quay lại. Sau phát hành kiểm health, SHA nguồn, vé sai bị từ chối và phiên chưa bắt đầu mở lại. Nếu lỗi, dựng lại API từ image cũ, không sửa dữ liệu thi hoặc điểm.

Sau phát hành: `deploy.sh --check` trả `COMPOSE_VALID`; image mới healthy và API công khai báo `1.8.9-listening-retake-unlimited`, SHA image `00ed0a911254acf9a14069331d5b4291a706d1433f1464b3fb28b6960b439a64`. Trang Pages trả HTTP 200. Vé thi bù hợp lệ đã mở lại đúng phiên chưa bắt đầu (HTTP 201), không có bài nộp; vé giả bị từ chối HTTP 403. Vé và danh tính học viên không nằm trong Git.

Lưu ý: vé không hết hạn là một liên kết riêng tư có hiệu lực lâu dài. Chỉ gửi cho đúng học viên; nếu bị lộ, cần cơ chế thu hồi hoặc đổi bí mật ký vé.
