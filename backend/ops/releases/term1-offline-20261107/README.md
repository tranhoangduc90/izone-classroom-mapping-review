# Offline Term Test 1 K56

Gói nối Term 1 vào runtime K56 **sau Term 2**, không dựng lại từ backend main. Baseline exact image/source nằm ở `baseline.json`; `patch-live.py` kiểm từng hash trước khi nối đúng các file trong gói. Source cấu hình, secret, rubric, câu hỏi và dữ liệu lịch sử giữ nguyên.

- Term 1: policy `term1-offline-v1`, Task 2, hai bảng `term1_offline_run`/`term1_offline_operation`.
- Term 2: wrapper giữ `term2-offline-v1`, Task 1, bảng và HMAC cũ; header transport vẫn `x-term2-permit`.
- `k56-offline-core.mjs`: profile đóng chọn bảng/Task; slug guard chạy trước limiter. Receipt, bài native và outbox commit cùng giao dịch. Scanner riêng theo bảng bù sau crash.
- Canonical Writing được đọc từ DB. Task 2 trắng hợp lệ tạo run `blank_rule`, final0/outbox0, không tạo job AI. Bài có chữ dùng grader native Task 2; không thêm Task 1 giả.
- Khóa đáp án Term 1 được kiểm thêm theo định nghĩa đã ghim: Listening41 ô/40 điểm, Reading26. Grader compound native không đổi.

## Cấp mới, nhận lại và quay lui

`TERM1_OFFLINE_NEW_ENABLED` chỉ mở khi bằng chuỗi `true`; thiếu hoặc `false` là tắt. `TERM2_OFFLINE_NEW_ENABLED` giữ mặc định cũ. Tắt cấp mới vẫn nhận `/offline/status` và `/offline/operation` của quyền đã cấp. Chỉ lượt CBT chưa bắt đầu được cấp v2; lượt đang làm dùng native.

Chạy `python print-migration.py` để in migration bổ sung Term1. Admin chạy migration; API role `k56_shared_api` chỉ có SELECT/INSERT/UPDATE trên hai bảng, không CREATE/DELETE. Không xóa hoặc khôi phục đè dữ liệu cũ khi quay code. Khi đã có Term1 v2, giữ receiver và secret; ưu tiên tắt cấp mới và quay phần Pages bị lỗi.

Phát API tương thích trước với cờ Term1 tắt, kiểm source/config/mount/Hub, phát Pages rồi bật riêng Term1. Baseline có adapter journal gắn mount ngoài image: phải chuyển đúng mount mới và giữ toàn bộ cấu hình/network khác. Bộ vận hành riêng tư lưu backup, image, cấu hình và readback; không đưa env/dump vào repo.

## Kiểm cô lập

`test.mjs` chọn `K56_TEST_PRODUCT=1|2`, dùng native source tại `TERM2_RUNTIME_ROOT`; các biến TERM2 được giữ để tái dùng runner. `TERM2_DEPS_PACKAGE` trỏ package Node24. Có thể dùng PGlite local hoặc PostgreSQL16 fixture; URL PG chỉ chấp nhận hostname fixture của ngày này. Không dùng DB học viên.

`preflight.test.mjs`: CORS/journal và cách ly route. `term1-specific.test.mjs`: câu32, L40/R26, Task2=6, opt-in. `fake-grading.mjs` chỉ tạo phản hồi AI giả trong fixture, không gọi provider hoặc Portal. Báo cáo phát hành và các lượt đủ giờ được lưu trong bộ nhớ dự án sau khi kiểm xong.
