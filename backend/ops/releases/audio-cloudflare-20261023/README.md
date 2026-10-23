# Audio Cloudflare 512 KiB, Pages dự phòng

Worker dùng R2 private và WebCrypto AES-GCM theo từng phần 524.288 byte. Catalog gồm 12 MP3 **đã công khai** trên Pages: Term/Mini K56/K67, bốn Substitute và Listening buổi 8/10. Vé/khóa vận chuyển sống 10 phút, khác nhau theo lượt tải; đây không phải khóa đăng nhập hoặc quyền thi. API gốc tiếp tục kiểm người, lớp, phiên, generation, thứ tự thi và quyền xem lại. Không đưa cookie/bearer gốc tới Worker/Pages.

Worker production: `https://izone-audio-delivery.tranhoangduc90.workers.dev`. Không dùng deadline của Worker lab cho production. Bucket giữ private; không bật `r2.dev`. Cấu hình triển khai có secret nằm ở kho vận hành riêng, không trong Git. Giữ Workers Free; không cấu hình CPU lớn hơn gói Free hoặc tự nâng Paid.

## Adapter và cờ bật

- K56 thật/demo: `audio-pages-20261023/k56-public-audio.mjs` cùng `cloudflare-audio.mjs` vào `/app/src/` của **đúng image đang chạy**.
- K67: `products/term-mini-k67/src/audio-access.js`, `cloudflare-audio.mjs`.
- Listening: `products/listening-practice/src/public-audio.js`, `cloudflare-audio.mjs`.
- Mỗi runtime tự đọc `AUDIO_CLOUDFLARE_ENABLED=true`; mặc định tắt. `AUDIO_CLOUDFLARE_ASSETS` là danh sách SHA-256 cách nhau bằng dấu phẩy để bật từng bài. Chuỗi rỗng bật không bài nào; bỏ biến này cho phép các MP3 đúng catalog của runtime đó.
- Chỉ metadata đúng cả hash, URL và dung lượng trong catalog mới có capability `cloudflare`. Không ghi capability vào snapshot hoặc thay bản ghim cũ. MP3 khác phiên bản và IZTT1 tiếp tục tuyến cũ.
- Pages dùng `shared/audio/transport.mjs`; config Origin production và các allowlist `SUBSTITUTE_ASSETS`, `REVIEW_ASSETS` bật riêng tuyến vốn công khai. K56/K67/Listening chờ capability từ API đã kiểm quyền. Client/API cũ tiếp tục tải theo hợp đồng cũ.

## Giữ hành vi và quan sát

Client kiểm hash từng phần và toàn file trước tạo Blob. Hai request song song; lỗi nguồn thử lại hữu hạn rồi dùng Pages cho phần còn thiếu. API/vé báo 401/403 thì dừng; lỗi quota Cloudflare 1027 được nhận diện riêng. Giữ phần đã kiểm, cache public 24 giờ, bỏ cache hỏng, lỗi IndexedDB chuyển RAM. Cầu dao nguồn 10 phút không thay quyết định quyền.

Listening có ngân sách tải tổng 120 giây, timeout riêng từng phần và hủy khi pause/reset/đổi người. Thời gian tải không khởi động hoặc cấp lại giờ thi. Không đổi timer, storage key, owner/lease, đáp án, điểm, nộp/phục hồi, Writing, Portal hoặc Docs.

Worker chỉ log asset, số phần, số byte và revision. Không log khóa, vé, cookie hoặc người học. Trace CPU là mẫu, không tự chứng minh mọi request hay tải 400 thiết bị. Free có hạn request ngày; Pages cũng có soft limit băng thông, nên dự phòng không bảo đảm chịu sự cố kéo dài cả tháng.

## Kiểm và quay lui

`adapters.test.mjs` kiểm 12 bản cố định, phiên ghim cũ, cờ và parity các adapter. `test_release_control.py` kiểm bảo toàn cấu hình, drift và quay lui khi health lỗi. Test native K67/Listening có chế độ `TEST_CF_AUDIO=1`; giữ fixture và hạn chế thật của từng runner, không bỏ guard để dùng DB production.

Triển khai ghép từ live image; mỗi runtime chỉ thay một module và thêm helper. `release-control.py` chỉ cho sửa hai biến cờ nêu trên, giữ port/mount/network/secret. Lưu receipt từng lần chuyển và container cũ. Canary lỗi thì quay riêng runtime vừa chuyển, giữ DB hiện tại; không restore dump/reset/chấm lại để quay code. Có thể tắt capability hoặc nguồn Worker để client dùng Pages, đồng thời giữ tương thích phiên cũ.

Bằng chứng vận hành chi tiết và các SHA/PR hiện hành được lưu trong runbook audio của repo điều phối; không đưa snapshot DB, file đề riêng hoặc credential vào repo này.
