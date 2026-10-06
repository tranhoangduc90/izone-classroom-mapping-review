# Backend Term Test/Mini Test K67 riêng

Gói này phục vụ thi, chấm và xem kết quả K67. Mã nghiệp vụ được ghim từ snapshot backend đang chạy; ứng dụng không khởi động Speaking, Progress Log hoặc Writing ngoài Term.

## Cách dựng và chạy

Dùng Node 24.15.0 và dependency trong package-lock. `npm ci --ignore-scripts` dựng dependency riêng; `npm start` mở backend sau khi kiểm cấu hình và danh tính DB. `npm test` chứa cả ca cần database/HTTP fixture: phải chuẩn bị biến môi trường và dữ liệu giả theo TEST_PLAN.md trước khi chạy, không trỏ bộ test vào bài thật.

Tất cả cấu hình ứng dụng dùng tiền tố `K67_`. Database phải tên `term_mini_k67`, role ứng dụng `k67_app`, đường API `/term-mini-k67-api`. Cấu hình thiếu/sai làm khởi động dừng và nêu tên trường lỗi. Không đưa giá trị khóa hoặc URL chứa mật khẩu vào Git.

## Phạm vi nghiệm thu

K67 đã chuyển sang runtime, PostgreSQL, Redis, cấu hình và bộ workflow riêng. Chín trang đã phát hành cấu hình mới; đường bài thi cũ vẫn dẫn tới K67 để giữ tương thích. K56 tiếp tục chạy trên runtime/tuyến hiện có. Dữ liệu lớp/quyền được đồng bộ qua API đọc giới hạn; ứng dụng K67 không đọc DB chung.

Ba hành trình Nghe–Đọc–Viết mô phỏng trên production đã đạt. Dữ liệu lịch sử 13 bảng vẫn khớp snapshot cuối. Đã diễn tập chuyển sang runtime K67 thứ hai rồi quay lại bản chính trên cùng kho có bài mới; kết quả không đổi. Xem RELEASE_STATUS.md cho biên nhận, giới hạn kiểm và CUTOVER_PLAN.md cho cách vận hành/quay lại.

Snapshot nguồn và hash từng file nằm trong evidence riêng của task. Source chuẩn ở worktree này, không chép sang thư mục Lớp 67. Xem DISCOVERY.md và TEST_PLAN.md để theo dõi toàn bộ phạm vi chuyển.

Các helper chuẩn bị/migration là công cụ cho lần chuyển này, không phải lệnh triển khai định kỳ. Không chạy lại restore vào kho đang có bài. Các helper `verify-production-readiness.py`, `verify-historical-preservation.py` và pha `observe` của `verify-production-journeys.py` chỉ đọc lại trạng thái; chúng không chấm lại bài.
