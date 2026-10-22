# Backend Term Test/Mini Test K67 riêng

**Nộp/phục hồi 23/10/2026:** đọc [module canonical, parity và quy tắc giữ cho bài sau](../../backend/ops/releases/term-mini-submit-20261023/README.md) trước sửa API hoặc thêm test. `submission-status` chỉ đọc; Reading dùng token lượt, guard chủ audio chỉ áp Listening. Giữ bài/điểm/generation và Writing hiện hành; hồ sơ 17/10 dưới đây là mốc của chính phần đó.

Gói này phục vụ thi, chấm và xem kết quả K67. Mã nghiệp vụ được ghim từ snapshot backend đang chạy; ứng dụng không khởi động Speaking, Progress Log hoặc Writing ngoài Term.

**Bản hiện hành 17/10/2026:** đọc [Quy tắc bài trắng và phiếu dự phòng](BLANK_WRITING_RELEASE_20261017.md). Áp dụng Term 1/2, Listening trước và Reading trước: bài chính thức nộp trắng nhận 0 không gọi AI; phiếu L/R không tạo Writing. Bản này thay luật ưu tiên bài có nội dung của [đợt khôi phục trước](WRITING_RESULT_RELEASE_20261017.md). Giữ ảnh audio làm nền; không suy toàn main tương đương runtime.

## Cách dựng và chạy

Dùng Node 24.15.0 và dependency trong package-lock. `npm ci --ignore-scripts` dựng dependency riêng; `npm start` mở backend sau khi kiểm cấu hình và danh tính DB. `npm test` chứa cả ca cần database/HTTP fixture: phải chuẩn bị biến môi trường và dữ liệu giả theo TEST_PLAN.md trước khi chạy, không trỏ bộ test vào bài thật.

Tất cả cấu hình ứng dụng dùng tiền tố `K67_`. Database phải tên `term_mini_k67`, role ứng dụng `k67_app`, đường API `/term-mini-k67-api`. Cấu hình thiếu/sai làm khởi động dừng và nêu tên trường lỗi. Không đưa giá trị khóa hoặc URL chứa mật khẩu vào Git.

## Phạm vi nghiệm thu

K67 đã chuyển sang runtime, PostgreSQL, Redis, cấu hình và bộ workflow riêng. Chín trang đã phát hành cấu hình mới; đường bài thi cũ vẫn dẫn tới K67 để giữ tương thích. K56 tiếp tục chạy trên runtime/tuyến hiện có. Dữ liệu lớp/quyền được đồng bộ qua API đọc giới hạn; ứng dụng K67 không đọc DB chung.

Ba hành trình Nghe–Đọc–Viết mô phỏng trên production đã đạt. Dữ liệu lịch sử 13 bảng vẫn khớp snapshot cuối. Đã diễn tập chuyển sang runtime K67 thứ hai rồi quay lại bản chính trên cùng kho có bài mới; kết quả không đổi. Xem RELEASE_STATUS.md cho biên nhận, giới hạn kiểm và CUTOVER_PLAN.md cho cách vận hành/quay lại.

Snapshot nguồn và hash từng file nằm trong evidence riêng của task. Source chuẩn ở worktree này, không chép sang thư mục Lớp 67. Xem DISCOVERY.md và TEST_PLAN.md để theo dõi toàn bộ phạm vi chuyển.

Các helper chuẩn bị/migration là công cụ cho lần chuyển này, không phải lệnh triển khai định kỳ. Không chạy lại restore vào kho đang có bài. Các helper `verify-production-readiness.py`, `verify-historical-preservation.py` và pha `observe` của `verify-production-journeys.py` chỉ đọc lại trạng thái; chúng không chấm lại bài.

## Audio MP3 Pages — 17/10/2026

`K67_PUBLIC_AUDIO_ENABLED=true` cho client hỗ trợ MP3 nhận catalog Pages: Term 1/Mini 128 kbps, Term 2 giữ gốc 96 kbps theo lựa chọn của Đức. Cả Listening trước và Reading trước dùng cùng bộ tải/kiểm file/phục hồi. VPS vẫn giữ quyền, phiên bản ghim và toàn bộ giờ thi/phục hồi. Client cũ và phiên đã ghim mã hóa tiếp tục dùng nguồn cũ. Không thay file gốc trên VPS. Tắt cờ để ngừng cấp MP3 cho phiên mới; giữ URL và frontend tương thích cho phiên đã ghim. Không khôi phục database để quay lui runtime.
